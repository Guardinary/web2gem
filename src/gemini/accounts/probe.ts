import type { RuntimeConfig } from "../../config";
import { errorLogSummary } from "../../shared/errors";
import { nowSec } from "../../shared/logging";
import { log } from "../../shared/logging";
import { GEMINI_WEB_USER_AGENT } from "../constants";
import { extractWrbInnerPayloads } from "../client/parser";
import { httpFetch } from "../transport";
import { getFreshPageTokensForConfig } from "../uploads/tokens";
import type { GeminiAccountIssue } from "./domain";
import type {
	GeminiAccountProbe,
	GeminiAccountVerificationLevel,
	GeminiAccountVerificationResult,
} from "./types";

const GET_USER_STATUS_RPC_ID = "otAQ7b";
const MAX_PROBE_RESPONSE_CHARS = 512 * 1024;
const MAX_PROBE_MODELS = 128;
const MAX_MODEL_ID_CHARS = 256;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export async function verifyGeminiAccount(input: {
	config: RuntimeConfig;
	level: GeminiAccountVerificationLevel;
}): Promise<GeminiAccountVerificationResult> {
	const tokens = await getFreshPageTokensForConfig(input.config);
	const at = typeof tokens.at === "string" ? tokens.at.trim() : "";
	if (!at) return { ok: false, reason: "missing_page_at_token" };
	if (input.level === "session") return { ok: true, at };
	try {
		const probe = await fetchGeminiAccountProbe(input.config, at);
		return { ok: true, at, probe };
	} catch (error) {
		log(
			input.config,
			`Gemini account status probe failed ${errorLogSummary(error)}`,
		);
		return { ok: false, reason: "status_probe_failed" };
	}
}

export async function fetchGeminiAccountProbe(
	cfg: RuntimeConfig,
	at: string,
): Promise<GeminiAccountProbe> {
	const origin = (cfg.gemini_origin || "https://gemini.google.com").replace(
		/\/$/,
		"",
	);
	const params = new URLSearchParams({
		rpcids: GET_USER_STATUS_RPC_ID,
		hl: "en",
		_reqid: String(nowSec() % 1000000),
		rt: "c",
		"source-path": "/app",
	});
	if (cfg.gemini_bl) params.set("bl", cfg.gemini_bl);
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Origin: origin,
		Referer: `${origin}/app`,
		"X-Same-Domain": "1",
		"User-Agent": GEMINI_WEB_USER_AGENT,
		"Accept-Language": "en-US,en;q=0.9",
	};
	if (cfg.cookie) headers.Cookie = cfg.cookie;
	const body = new URLSearchParams({
		at,
		"f.req": JSON.stringify([
			[[GET_USER_STATUS_RPC_ID, "[]", null, "generic"]],
		]),
	}).toString();
	const response = await httpFetch(
		`${origin}/_/BardChatUi/data/batchexecute?${params}`,
		{
			method: "POST",
			headers,
			body,
			timeoutMs: Math.min(
				Math.max(Number(cfg.request_timeout_sec) || 30, 1) * 1000,
				30000,
			),
			socket: cfg.upstream_socket,
			socketFallback: "never",
			cfg,
		},
	);
	if (!response.ok)
		throw new Error(`Gemini account probe failed with HTTP ${response.status}`);
	return decodeGeminiAccountProbe(
		await readBoundedResponseText(response, MAX_PROBE_RESPONSE_CHARS),
	);
}

export function decodeGeminiAccountProbe(raw: unknown): GeminiAccountProbe {
	for (const payload of extractWrbInnerPayloads(raw)) {
		const statusCode = boundedInt(payload[14]);
		if (statusCode === undefined) continue;
		const status = accountStatus(statusCode);
		if (!status) throw new Error("unknown Gemini account status");
		const models = decodeModels(payload[15], payload[16], payload[17]);
		return {
			statusCode,
			issue: status.issue,
			selectable: status.selectable,
			models,
		};
	}
	throw new Error("missing Gemini account status payload");
}

function accountStatus(
	statusCode: number,
): { issue: GeminiAccountIssue | null; selectable: boolean } | null {
	if (statusCode === 1000) return { issue: null, selectable: true };
	if (statusCode === 1014) return { issue: "transient", selectable: false };
	if (statusCode === 1016) return { issue: "auth", selectable: false };
	if ([1021, 1033, 1040, 1042, 1054, 1057].includes(statusCode))
		return { issue: "user_action", selectable: false };
	if (statusCode === 1060) return { issue: "location", selectable: false };
	return null;
}

function decodeModels(
	rawModels: unknown,
	tierFlags: unknown,
	capabilityFlags: unknown,
): GeminiAccountProbe["models"] {
	if (!Array.isArray(rawModels) || !rawModels.length) return [];
	if (rawModels.length > MAX_PROBE_MODELS)
		throw new Error("Gemini account probe returned too many models");
	const capacity = firstBoundedInt(tierFlags);
	const capacityField = firstBoundedInt(capabilityFlags);
	const out: GeminiAccountProbe["models"] = [];
	for (const item of rawModels) {
		if (!Array.isArray(item)) continue;
		const modelId = typeof item[0] === "string" ? item[0].trim() : "";
		if (
			!modelId ||
			modelId.length > MAX_MODEL_ID_CHARS ||
			!MODEL_ID_PATTERN.test(modelId)
		)
			continue;
		const model: GeminiAccountProbe["models"][number] = {
			modelId,
			available: true,
		};
		if (capacity !== undefined) model.capacity = capacity;
		if (capacityField !== undefined) model.capacityField = capacityField;
		out.push(model);
	}
	return out;
}

function firstBoundedInt(value: unknown): number | undefined {
	if (!Array.isArray(value)) return boundedInt(value);
	for (const item of value) {
		const direct = boundedInt(item);
		if (direct !== undefined) return direct;
		if (Array.isArray(item)) {
			const nested = firstBoundedInt(item);
			if (nested !== undefined) return nested;
		}
	}
	return undefined;
}

function boundedInt(value: unknown): number | undefined {
	const number = Number(value);
	return Number.isInteger(number) && number >= 0 && number <= 1_000_000
		? number
		: undefined;
}

async function readBoundedResponseText(
	response: {
		body?: ReadableStream<Uint8Array> | null;
		text(): Promise<string>;
	},
	maxChars: number,
): Promise<string> {
	if (!response.body) {
		const text = await response.text();
		if (text.length > maxChars)
			throw new Error("Gemini account probe too large");
		return text;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			if (text.length > maxChars)
				throw new Error("Gemini account probe too large");
		}
		text += decoder.decode();
		if (text.length > maxChars)
			throw new Error("Gemini account probe too large");
		return text;
	} finally {
		try {
			reader.releaseLock();
		} catch (_) {}
	}
}
