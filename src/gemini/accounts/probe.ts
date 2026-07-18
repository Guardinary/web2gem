import type { RuntimeConfig } from "../../config";
import {
	isGeminiProviderModelId,
	MAX_GEMINI_DISCOVERED_MODELS,
	MAX_GEMINI_MODEL_DESCRIPTION_CODE_POINTS,
	MAX_GEMINI_MODEL_DISPLAY_NAME_CODE_POINTS,
} from "../../models";
import { errorLogSummary } from "../../shared/errors";
import { log, nowSec } from "../../shared/logging";
import { extractWrbInnerPayloads } from "../client/parse-envelope";
import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import { getFreshPageTokensForConfig } from "../uploads/tokens";
import type { GeminiAccountIssue } from "./domain";
import { basicRouteForFamily, modelNumberForProviderModelId } from "./routes";
import type {
	GeminiAccountProbe,
	GeminiAccountVerificationLevel,
	GeminiAccountVerificationResult,
} from "./probe-types";

const GET_USER_STATUS_RPC_ID = "otAQ7b";
const MAX_PROBE_RESPONSE_CHARS = 512 * 1024;
const MAX_PROBE_FLAG_VALUES = 256;
const ANONYMOUS_FLASH_PROVIDER_MODEL_ID =
	basicRouteForFamily("flash").providerModelId;

export async function verifyGeminiAccount(input: {
	config: RuntimeConfig;
	level: GeminiAccountVerificationLevel;
}): Promise<GeminiAccountVerificationResult> {
	const tokens = await getFreshPageTokensForConfig(input.config);
	const at = typeof tokens.at === "string" ? tokens.at.trim() : "";
	if (!at) return { ok: false, reason: "missing_page_at_token" };
	if (input.level === "session") return { ok: true };
	try {
		const probe = await fetchGeminiAccountProbe(input.config, at);
		return { ok: true, probe };
	} catch (error) {
		log(
			input.config,
			`Gemini account status probe failed ${errorLogSummary(error)}`,
		);
		return { ok: false, reason: "status_probe_failed" };
	}
}

async function fetchGeminiAccountProbe(
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
		const models = decodeModels(
			payload[15],
			payload[16],
			payload[17],
			statusCode,
		);
		return {
			statusCode,
			issue: status.issue,
			models,
		};
	}
	throw new Error("missing Gemini account status payload");
}

function accountStatus(
	statusCode: number,
): { issue: GeminiAccountIssue | null } | null {
	if (statusCode === 1000) return { issue: null };
	if (statusCode === 1014) return { issue: "transient" };
	if (statusCode === 1016) return { issue: "auth" };
	if ([1021, 1033, 1040, 1042, 1054, 1057].includes(statusCode))
		return { issue: "user_action" };
	if (statusCode === 1060) return { issue: "location" };
	return null;
}

function decodeModels(
	rawModels: unknown,
	tierFlags: unknown,
	capabilityFlags: unknown,
	statusCode: number,
): GeminiAccountProbe["models"] {
	if (!Array.isArray(rawModels) || !rawModels.length) return [];
	if (rawModels.length > MAX_GEMINI_DISCOVERED_MODELS)
		throw new Error("Gemini account probe returned too many models");
	const { capacity, capacityField } = accountModelCapacity(
		tierFlags,
		capabilityFlags,
	);
	const out: GeminiAccountProbe["models"] = [];
	for (
		let discoveryOrder = 0;
		discoveryOrder < rawModels.length;
		discoveryOrder++
	) {
		const item = rawModels[discoveryOrder];
		if (!Array.isArray(item)) continue;
		const modelId = typeof item[0] === "string" ? item[0].trim() : "";
		if (!isGeminiProviderModelId(modelId)) continue;
		const displayName = boundedModelText(
			item[1],
			MAX_GEMINI_MODEL_DISPLAY_NAME_CODE_POINTS,
			false,
		);
		const description = boundedModelText(
			item[2],
			MAX_GEMINI_MODEL_DESCRIPTION_CODE_POINTS,
			true,
		);
		if (displayName === null || description === null) continue;
		out.push({
			modelId,
			displayName,
			description,
			available:
				statusCode !== 1016 || modelId === ANONYMOUS_FLASH_PROVIDER_MODEL_ID,
			capacity,
			capacityField,
			modelNumber: modelNumberForProviderModelId(modelId),
			discoveryOrder,
		});
	}
	return out;
}

function boundedModelText(
	value: unknown,
	maxCodePoints: number,
	allowEmpty: boolean,
): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	if (!allowEmpty && !normalized) return null;
	let codePoints = 0;
	for (const _codePoint of normalized) {
		codePoints += 1;
		if (codePoints > maxCodePoints) return null;
	}
	return normalized;
}

function accountModelCapacity(
	tierFlags: unknown,
	capabilityFlags: unknown,
): { capacity: number; capacityField: 12 | 13 } {
	const tiers = boundedIntSet(tierFlags);
	const capabilities = boundedIntSet(capabilityFlags);
	if (tiers.has(21)) return { capacity: 1, capacityField: 13 };
	if (tiers.has(22)) return { capacity: 2, capacityField: 13 };
	if (capabilities.has(115)) return { capacity: 4, capacityField: 12 };
	if (tiers.has(16) || capabilities.has(106))
		return { capacity: 3, capacityField: 12 };
	if (tiers.has(8) || (!capabilities.has(106) && capabilities.has(19)))
		return { capacity: 2, capacityField: 12 };
	return { capacity: 1, capacityField: 12 };
}

function boundedIntSet(value: unknown): Set<number> {
	const out = new Set<number>();
	const pending: unknown[] = [value];
	let scanned = 0;
	while (pending.length && scanned < MAX_PROBE_FLAG_VALUES) {
		const item = pending.pop();
		scanned += 1;
		if (Array.isArray(item)) {
			for (let index = item.length - 1; index >= 0; index--)
				pending.push(item[index]);
			continue;
		}
		const number = boundedInt(item);
		if (number !== undefined) out.add(number);
	}
	return out;
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
