import {
	extractGeminiAppPageTokens,
	extractGeminiPushId,
	type GeminiAppPageTokens,
} from "../app-page";
import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import { createOriginScopedStringCache } from "../cache";
import type { RuntimeConfig } from "../../config";
import { configWithFreshGeminiCookie } from "../cookies";
import { TEXT_ENCODER } from "../../shared/encoding";
import { bytesToHex } from "../../shared/crypto";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import { contentPushUploadError } from "./errors";

type PageTokens = GeminiAppPageTokens;
type PageTokenCache = { key: string; tokens: PageTokens | null; ts: number };
type PageTokenPending = { key: string; promise: Promise<PageTokens> | null };
type ContentPushUploadTokens = {
	pushId: string;
};

const GEMINI_UPLOAD_USER_AGENT = GEMINI_WEB_USER_AGENT;
const GEMINI_PUSH_ID_CACHE_TTL_SEC = 12 * 60 * 60;
export let _pageTokens: PageTokenCache = { key: "", tokens: null, ts: 0 };
export let _pageTokensPending: PageTokenPending = { key: "", promise: null };

const PAGE_TOKEN_CACHE_TTL_MS = 600000;
const EMPTY_PAGE_TOKEN_CACHE_TTL_MS = 30000;
const pushIdCache = createOriginScopedStringCache({
	cachePrefix: "https://internal-cache/gemini-push-id/",
	ttlSec: GEMINI_PUSH_ID_CACHE_TTL_SEC,
	payloadKey: "push_id",
	logLabel: "Gemini push_id",
	accountScoped: true,
});

export function resetGeminiUploadCachesForTest(): void {
	_pageTokens = { key: "", tokens: null, ts: 0 };
	_pageTokensPending = { key: "", promise: null };
	pushIdCache.reset();
}

export async function getPageTokens(cfg: RuntimeConfig): Promise<PageTokens> {
	const activeCfg = await configWithFreshGeminiCookie(cfg);
	return getPageTokensForConfig(activeCfg);
}

export async function getPageTokensForConfig(
	activeCfg: RuntimeConfig,
): Promise<PageTokens> {
	const now = Date.now();
	const cacheKey = await pageTokenCacheKey(activeCfg);
	if (
		_pageTokens.tokens &&
		_pageTokens.key === cacheKey &&
		now - _pageTokens.ts < pageTokenCacheTtl(_pageTokens.tokens)
	)
		return _pageTokens.tokens;
	if (_pageTokensPending.promise && _pageTokensPending.key === cacheKey)
		return _pageTokensPending.promise;
	const promise = (async () => {
		const headers: Record<string, string> = {
			"User-Agent": GEMINI_UPLOAD_USER_AGENT,
			"Accept-Language": "en-US,en;q=0.9",
		};
		if (activeCfg.cookie) headers.Cookie = activeCfg.cookie;
		const tokens: PageTokens = {};
		let shouldCache = true;
		try {
			const resp = await httpFetch(
				`${activeCfg.gemini_origin || "https://gemini.google.com"}/app`,
				{
					headers,
					timeoutMs: 30000,
					socket: activeCfg.upstream_socket,
					cfg: activeCfg,
				},
			);
			Object.assign(tokens, await extractGeminiAppPageTokens(resp));
			if (!hasAnyPageToken(tokens)) {
				log(
					activeCfg,
					"gemini app page token markers missing; content-push upload unavailable",
				);
			}
		} catch (e) {
			shouldCache = false;
			log(
				activeCfg,
				`gemini app page token fetch failed; content-push upload unavailable ${errorLogSummary(e)}`,
			);
		}
		if (shouldCache) _pageTokens = { key: cacheKey, tokens, ts: now };
		return tokens;
	})();
	_pageTokensPending = { key: cacheKey, promise };
	try {
		return await promise;
	} finally {
		if (_pageTokensPending.promise === promise)
			_pageTokensPending = { key: "", promise: null };
	}
}

async function pageTokenCacheKey(cfg: RuntimeConfig): Promise<string> {
	const origin = (cfg.gemini_origin || "https://gemini.google.com").replace(
		/\/$/,
		"",
	);
	const account = cfg.gemini_account;
	if (account) {
		return `${origin}\x00account:${account.accountId || ""}\x00cookie:${account.cookieHash || ""}`;
	}
	if (!cfg.cookie) return `${origin}\x00anonymous`;
	const digest = await crypto.subtle.digest(
		"SHA-256",
		TEXT_ENCODER.encode(cfg.cookie),
	);
	return `${origin}\x00cookie_sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export async function getGeminiPushId(cfg: RuntimeConfig): Promise<string> {
	const cachedPushId = await getCachedGeminiPushId(cfg);
	if (cachedPushId) return cachedPushId;
	return getFreshGeminiPushId(cfg);
}

export async function getCachedGeminiPushId(
	cfg: RuntimeConfig,
): Promise<string> {
	return pushIdCache.getCached(cfg);
}

export async function setCachedGeminiPushId(
	cfg: RuntimeConfig,
	value: string,
): Promise<void> {
	await pushIdCache.setCached(cfg, value);
}

export async function refreshGeminiPushId(cfg: RuntimeConfig): Promise<string> {
	await pushIdCache.deleteCached(cfg);
	return getFreshGeminiPushId(cfg);
}

async function getFreshGeminiPushId(cfg: RuntimeConfig): Promise<string> {
	return pushIdCache.getFresh(cfg, fetchFreshGeminiPushId);
}

export function contentPushUploadTokens(
	pushId: string | null | undefined,
	protocol: string,
): ContentPushUploadTokens {
	const value = validGeminiPushId(pushId);
	if (!value) {
		throw contentPushUploadError(
			"content_push_missing_page_token",
			`content-push ${protocol} upload missing Gemini page token: push_id`,
			{ protocol },
		);
	}
	return { pushId: value };
}

function pageTokenCacheTtl(tokens: PageTokens): number {
	return hasAnyPageToken(tokens)
		? PAGE_TOKEN_CACHE_TTL_MS
		: EMPTY_PAGE_TOKEN_CACHE_TTL_MS;
}

function hasAnyPageToken(tokens: PageTokens): boolean {
	return !!(tokens.at || tokens.push_id);
}

function validGeminiPushId(value: unknown): string {
	const pushId = typeof value === "string" ? value.trim() : "";
	return pushId ? pushId : "";
}

async function fetchFreshGeminiPushId(cfg: RuntimeConfig): Promise<string> {
	const activeCfg = await configWithFreshGeminiCookie(cfg);
	try {
		const headers: Record<string, string> = {
			"User-Agent": GEMINI_UPLOAD_USER_AGENT,
			"Accept-Language": "en-US,en;q=0.9",
		};
		if (activeCfg.cookie) headers.Cookie = activeCfg.cookie;
		const resp = await httpFetch(
			`${activeCfg.gemini_origin || "https://gemini.google.com"}/app`,
			{
				headers,
				timeoutMs: 30000,
				socket: activeCfg.upstream_socket,
				cfg: activeCfg,
			},
		);
		const pushId = validGeminiPushId(await extractGeminiPushId(resp));
		if (!pushId) {
			log(
				activeCfg,
				"gemini app page push_id marker missing; content-push upload unavailable",
			);
		}
		return pushId;
	} catch (e) {
		log(
			activeCfg,
			`gemini app page push_id fetch failed; content-push upload unavailable ${errorLogSummary(e)}`,
		);
		return "";
	}
}
