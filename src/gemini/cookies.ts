import type { RuntimeConfig } from "../config";
import { errorLogSummary } from "../shared/errors";
import { log } from "../shared/logging";
import { GEMINI_WEB_USER_AGENT } from "./constants";
import { httpFetch } from "./transport";

export type ActiveCookieState = {
	cookie: string;
	sapisid: string;
	secure1psid: string;
	secure1psidts: string;
	updatedAtMs: number;
	lastRotateAtMs: number;
	sourceKey: string;
};

export type CookieRotationReason =
	| "missing_cookie"
	| "missing_secure_1psid"
	| "account_runtime_managed"
	| "recent_rotation"
	| "rotation_rejected"
	| "rotation_failed"
	| "rotation_no_update"
	| "rotation_error"
	| "rotation_updated";

export type CookieRotationRetryResult = {
	config: RuntimeConfig | null;
	reason: CookieRotationReason;
	upstreamStatus?: number;
};

export const COOKIE_ROTATE_MIN_INTERVAL_MS = 60 * 1000;
export const COOKIE_ROTATE_STALE_MS = 10 * 60 * 1000;

let activeCookieState: ActiveCookieState | null = null;
let rotatePromise: Promise<ActiveCookieState | null> | null = null;
let lastRotationReason: CookieRotationReason = "missing_cookie";
let lastRotationUpstreamStatus = 0;

export function parseCookieHeader(cookieHeader: unknown): Map<string, string> {
	const map = new Map<string, string>();
	const raw = String(cookieHeader || "");
	for (const part of raw.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const name = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (name) map.set(name, value);
	}
	return map;
}

export function serializeCookieMap(cookies: Map<string, string>): string {
	return Array.from(cookies.entries())
		.filter(([name]) => !!name)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

export function extractCookieValue(
	cookieHeader: unknown,
	name: string,
): string {
	return parseCookieHeader(cookieHeader).get(name) || "";
}

export function splitSetCookieHeader(header: unknown): string[] {
	const raw = String(header || "").trim();
	if (!raw) return [];
	const out: string[] = [];
	let start = 0;
	let inQuote = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === '"' && raw[i - 1] !== "\\") inQuote = !inQuote;
		if (ch !== "," || inQuote || !looksLikeCookiePair(raw, i + 1)) continue;
		const part = raw.slice(start, i).trim();
		if (part) out.push(part);
		start = i + 1;
	}
	const tail = raw.slice(start).trim();
	if (tail) out.push(tail);
	return out;
}

export function setCookieHeaders(headers: Headers): string[] {
	return headers.getSetCookie();
}

export function mergeSetCookieHeaders(
	cookieHeader: unknown,
	setCookieValues: readonly string[],
): string {
	const cookies = parseCookieHeader(cookieHeader);
	for (const setCookie of setCookieValues) {
		const first =
			String(setCookie || "")
				.split(";")[0]
				?.trim() || "";
		const eq = first.indexOf("=");
		if (eq <= 0) continue;
		const name = first.slice(0, eq).trim();
		const value = first.slice(eq + 1).trim();
		if (name) cookies.set(name, value);
	}
	return serializeCookieMap(cookies);
}

export function configWithActiveGeminiCookie(
	cfg: RuntimeConfig,
): RuntimeConfig {
	if (cfg.gemini_account) return cfg;
	const state = ensureActiveCookieState(cfg);
	if (!state) return cfg;
	return {
		...cfg,
		cookie: state.cookie,
		sapisid: state.sapisid || cfg.sapisid,
	};
}

export async function configWithFreshGeminiCookie(
	cfg: RuntimeConfig,
): Promise<RuntimeConfig> {
	if (cfg.gemini_account) return cfg;
	const state = ensureActiveCookieState(cfg);
	if (!state) return cfg;
	if (Date.now() - state.updatedAtMs > COOKIE_ROTATE_STALE_MS) {
		const refreshed = await rotateGeminiCookie(cfg, { force: false });
		if (refreshed)
			return {
				...cfg,
				cookie: refreshed.cookie,
				sapisid: refreshed.sapisid || cfg.sapisid,
			};
	}
	return configWithActiveGeminiCookie(cfg);
}

export async function rotateGeminiCookieForRetry(
	cfg: RuntimeConfig,
): Promise<RuntimeConfig | null> {
	return (await rotateGeminiCookieForRetryWithReason(cfg)).config;
}

export async function rotateGeminiCookieForRetryWithReason(
	cfg: RuntimeConfig,
): Promise<CookieRotationRetryResult> {
	if (cfg.gemini_account) {
		setRotationReason("account_runtime_managed");
		return rotationRetryResult(null);
	}
	const current = configWithActiveGeminiCookie(cfg);
	const refreshed = await rotateGeminiCookie(current, { force: true });
	if (!refreshed || refreshed.cookie === current.cookie) {
		return rotationRetryResult(null);
	}
	return rotationRetryResult({
		...cfg,
		cookie: refreshed.cookie,
		sapisid: refreshed.sapisid || cfg.sapisid,
	});
}

async function rotateGeminiCookie(
	cfg: RuntimeConfig,
	options: { force: boolean },
): Promise<ActiveCookieState | null> {
	const state = ensureActiveCookieState(cfg);
	if (!state) {
		setRotationReason("missing_cookie");
		return null;
	}
	if (!state.secure1psid) {
		setRotationReason("missing_secure_1psid");
		log(cfg, "gemini cookie rotation skipped reason=missing_secure_1psid");
		return state;
	}
	if (rotatePromise) return rotatePromise;

	const now = Date.now();
	if (
		!options.force &&
		now - state.lastRotateAtMs < COOKIE_ROTATE_MIN_INTERVAL_MS
	)
		return state;
	if (
		options.force &&
		now - state.lastRotateAtMs < COOKIE_ROTATE_MIN_INTERVAL_MS
	) {
		setRotationReason("recent_rotation");
		log(cfg, "gemini cookie rotation skipped reason=recent_rotation");
		return state;
	}

	state.lastRotateAtMs = now;
	rotatePromise = rotateGeminiCookieOnce(cfg, state).finally(() => {
		rotatePromise = null;
	});
	return rotatePromise;
}

async function rotateGeminiCookieOnce(
	cfg: RuntimeConfig,
	state: ActiveCookieState,
): Promise<ActiveCookieState | null> {
	try {
		const resp = await httpFetch("https://accounts.google.com/RotateCookies", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://accounts.google.com",
				Referer: "https://accounts.google.com/",
				"User-Agent": GEMINI_WEB_USER_AGENT,
				"Accept-Language": "en-US,en;q=0.9",
				Cookie: state.cookie,
			},
			body: '[000,"-0000000000000000000"]',
			timeoutMs: Math.min(
				Math.max(Number(cfg.request_timeout_sec) || 30, 1) * 1000,
				30000,
			),
			socket: cfg.upstream_socket,
			socketFallback: "never",
			cfg,
		});
		if (resp.status === 401 || resp.status === 403) {
			setRotationReason("rotation_rejected", resp.status);
			log(cfg, `gemini cookie rotation rejected upstreamStatus=${resp.status}`);
			return state;
		}
		if (!resp.ok) {
			setRotationReason("rotation_failed", resp.status);
			log(cfg, `gemini cookie rotation failed upstreamStatus=${resp.status}`);
			return state;
		}

		const mergedCookie = mergeSetCookieHeaders(
			state.cookie,
			setCookieHeaders(resp.headers),
		);
		const next = stateFromCookie(
			mergedCookie,
			state.sourceKey,
			state.lastRotateAtMs,
			cfg.sapisid,
		);
		if (!next || next.cookie === state.cookie) {
			setRotationReason("rotation_no_update");
			log(cfg, "gemini cookie rotation completed without cookie update");
			return state;
		}
		activeCookieState = next;
		setRotationReason("rotation_updated");
		log(cfg, "gemini cookie rotation updated active cookie");
		return next;
	} catch (e) {
		setRotationReason("rotation_error");
		log(cfg, `gemini cookie rotation error ${errorLogSummary(e)}`);
		return state;
	}
}

function ensureActiveCookieState(cfg: RuntimeConfig): ActiveCookieState | null {
	if (!cfg.cookie) {
		activeCookieState = null;
		return null;
	}
	const sourceKey = cookieSourceKey(cfg);
	if (activeCookieState && activeCookieState.sourceKey === sourceKey)
		return activeCookieState;
	activeCookieState = stateFromCookie(cfg.cookie, sourceKey, 0, cfg.sapisid);
	return activeCookieState;
}

function stateFromCookie(
	cookie: string,
	sourceKey: string,
	lastRotateAtMs: number,
	sapisidOverride?: unknown,
): ActiveCookieState | null {
	const cookies = parseCookieHeader(cookie);
	const normalizedCookie = serializeCookieMap(cookies);
	if (!normalizedCookie) return null;
	const sapisid = String(sapisidOverride || cookies.get("SAPISID") || "");
	return {
		cookie: normalizedCookie,
		sapisid,
		secure1psid: cookies.get("__Secure-1PSID") || "",
		secure1psidts: cookies.get("__Secure-1PSIDTS") || "",
		updatedAtMs: Date.now(),
		lastRotateAtMs,
		sourceKey,
	};
}

function cookieSourceKey(cfg: RuntimeConfig): string {
	const secure1psid = extractCookieValue(cfg.cookie, "__Secure-1PSID");
	const sapisid = String(
		cfg.sapisid || extractCookieValue(cfg.cookie, "SAPISID") || "",
	);
	return `${secure1psid || cfg.cookie || ""}\x00${sapisid}`;
}

export function resetActiveGeminiCookieForTest(): void {
	activeCookieState = null;
	rotatePromise = null;
	setRotationReason("missing_cookie");
}

function looksLikeCookiePair(raw: string, from: number): boolean {
	let i = from;
	while (i < raw.length && /\s/.test(raw[i] || "")) i++;
	const nameStart = i;
	while (i < raw.length) {
		const ch = raw[i] || "";
		if (ch === "=") return i > nameStart;
		if (ch === ";" || ch === "," || /\s/.test(ch)) return false;
		i++;
	}
	return false;
}

function setRotationReason(
	reason: CookieRotationReason,
	upstreamStatus = 0,
): void {
	lastRotationReason = reason;
	lastRotationUpstreamStatus = upstreamStatus;
}

function rotationRetryResult(
	config: RuntimeConfig | null,
): CookieRotationRetryResult {
	const result: CookieRotationRetryResult = {
		config,
		reason: lastRotationReason,
	};
	if (lastRotationUpstreamStatus)
		result.upstreamStatus = lastRotationUpstreamStatus;
	return result;
}

export function getLastGeminiCookieRotationReasonForTest(): CookieRotationRetryResult {
	return rotationRetryResult(null);
}
