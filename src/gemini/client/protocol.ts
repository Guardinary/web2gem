import { GEMINI_WEB_USER_AGENT } from "../constants";
import { makeSapisidHash } from "../auth";
import { nowSec } from "../../shared/logging";
import { uuid } from "../../shared/crypto";
import type { RuntimeConfig } from "../../config";

type PayloadFileRef =
	| string
	| {
			ref?: unknown;
			fileRef?: unknown;
			id?: unknown;
			name?: unknown;
			filename?: unknown;
	  };

const GEMINI_PAYLOAD_INNER_LENGTH = 102;
const GEMINI_PAYLOAD_FIELD = {
	request: 0,
	language: 1,
	clientContext: 2,
	defaultGenerationFlags: 6,
	requestKind: 7,
	responseMode: 10,
	toolMode: 11,
	thinkingMode: 17,
	responseSeed: 18,
	conversationMode: 27,
	responseOptions: 30,
	enhancedMode: 31,
	mediaMode: 41,
	safetyMode: 53,
	requestId: 59,
	toolContext: 61,
	clientFeature: 68,
	modelFamily: 79,
	enhancedRouting: 80,
} as const;
const MODEL_EXTRA_PAYLOAD_FIELDS = new Set<number>([
	GEMINI_PAYLOAD_FIELD.enhancedMode,
	GEMINI_PAYLOAD_FIELD.enhancedRouting,
]);

export function buildPayload(
	prompt: string,
	modelId: number,
	thinkMode: number,
	fileRefs: readonly PayloadFileRef[] | null,
	extra: Record<number, unknown> | null,
	requestId: string = uuid(),
): string {
	const inner = createGeminiPayloadInner(
		prompt,
		modelId,
		thinkMode,
		fileRefs,
		requestId.toUpperCase(),
	);
	applyModelPayloadExtras(inner, extra);
	const outer = [null, JSON.stringify(inner)];
	return new URLSearchParams({ "f.req": JSON.stringify(outer) }).toString();
}

function createGeminiPayloadInner(
	prompt: string,
	modelId: number,
	thinkMode: number,
	fileRefs: readonly PayloadFileRef[] | null,
	requestId: string,
): unknown[] {
	const inner = new Array(GEMINI_PAYLOAD_INNER_LENGTH);
	if (fileRefs?.length) {
		const files = fileRefs.map((item) => {
			if (item && typeof item === "object" && !Array.isArray(item)) {
				return [
					[item.ref || item.fileRef || item.id || "", 1],
					item.name || item.filename || "file.txt",
				];
			}
			return [[item, 1], "file.txt"];
		});
		inner[GEMINI_PAYLOAD_FIELD.request] = [
			prompt,
			0,
			null,
			files,
			null,
			null,
			0,
		];
	} else {
		inner[GEMINI_PAYLOAD_FIELD.request] = [
			prompt,
			0,
			null,
			null,
			null,
			null,
			0,
		];
	}
	inner[GEMINI_PAYLOAD_FIELD.language] = ["en"];
	inner[GEMINI_PAYLOAD_FIELD.clientContext] = [
		"",
		"",
		"",
		null,
		null,
		null,
		null,
		null,
		null,
		"",
	];
	inner[GEMINI_PAYLOAD_FIELD.defaultGenerationFlags] = [0];
	inner[GEMINI_PAYLOAD_FIELD.requestKind] = 1;
	inner[GEMINI_PAYLOAD_FIELD.responseMode] = 1;
	inner[GEMINI_PAYLOAD_FIELD.toolMode] = 0;
	inner[GEMINI_PAYLOAD_FIELD.thinkingMode] = [[thinkMode]];
	inner[GEMINI_PAYLOAD_FIELD.responseSeed] = 0;
	inner[GEMINI_PAYLOAD_FIELD.conversationMode] = 1;
	inner[GEMINI_PAYLOAD_FIELD.responseOptions] = [4];
	inner[GEMINI_PAYLOAD_FIELD.mediaMode] = [2];
	inner[GEMINI_PAYLOAD_FIELD.safetyMode] = 0;
	inner[GEMINI_PAYLOAD_FIELD.requestId] = requestId;
	inner[GEMINI_PAYLOAD_FIELD.toolContext] = [];
	inner[GEMINI_PAYLOAD_FIELD.clientFeature] = 1;
	inner[GEMINI_PAYLOAD_FIELD.modelFamily] = modelId;
	return inner;
}

function applyModelPayloadExtras(
	inner: unknown[],
	extra: Record<number, unknown> | null,
): void {
	if (extra) {
		for (const k of Object.keys(extra)) {
			const index = Number(k);
			if (!Number.isInteger(index) || !MODEL_EXTRA_PAYLOAD_FIELDS.has(index)) {
				throw new Error(`Unsupported Gemini model extra payload field: ${k}`);
			}
			inner[index] = extra[index];
		}
	}
}

export function getUrl(cfg: RuntimeConfig): string {
	const reqid = nowSec() % 1000000;
	const origin = (cfg.gemini_origin || "https://gemini.google.com").replace(
		/\/$/,
		"",
	);
	return (
		origin +
		"/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate" +
		`?bl=${encodeURIComponent(cfg.gemini_bl)}&hl=en&_reqid=${reqid}&rt=c`
	);
}

export async function buildHeaders(
	cfg: RuntimeConfig,
	modelHeaders: Record<string, string> | null = null,
	requestId: string | null = null,
): Promise<Record<string, string>> {
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Origin: "https://gemini.google.com",
		Referer: "https://gemini.google.com/app",
		"X-Same-Domain": "1",
		"User-Agent": GEMINI_WEB_USER_AGENT,
		"Accept-Language": "en-US,en;q=0.9",
	};
	if (modelHeaders) Object.assign(headers, modelHeaders);
	if (requestId)
		headers["x-goog-ext-525005358-jspb"] = `["${requestId.toUpperCase()}",1]`;
	if (cfg.cookie) headers.Cookie = cfg.cookie;
	if (cfg.sapisid) headers.Authorization = await makeSapisidHash(cfg.sapisid);
	return headers;
}
