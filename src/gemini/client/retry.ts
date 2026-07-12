import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import { extractGeminiBuildLabel } from "../app-page";
import { createOriginScopedStringCache } from "../cache";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import { sleep } from "../../shared/abort";
import type { RuntimeConfig } from "../../config";

export const GEMINI_BL_CACHE_TTL_SEC = 12 * 60 * 60;

const buildLabelCache = createOriginScopedStringCache({
	cachePrefix: "https://internal-cache/gemini-bl/",
	ttlSec: GEMINI_BL_CACHE_TTL_SEC,
	payloadKey: "gemini_bl",
	logLabel: "Gemini BL",
});

export async function getCachedGeminiBuildLabel(
	cfg: RuntimeConfig,
): Promise<string> {
	return buildLabelCache.getCached(cfg);
}

export async function setCachedGeminiBuildLabel(
	cfg: RuntimeConfig,
	label: string,
): Promise<void> {
	await buildLabelCache.setCached(cfg, label);
}

export async function configWithCachedGeminiBuildLabel(
	cfg: RuntimeConfig,
): Promise<RuntimeConfig> {
	const cachedBL = await getCachedGeminiBuildLabel(cfg);
	if (!cachedBL || cachedBL === cfg.gemini_bl) return cfg;
	return { ...cfg, gemini_bl: cachedBL };
}

export async function getFreshGeminiBuildLabel(
	cfg: RuntimeConfig,
): Promise<string> {
	return buildLabelCache.getFresh(cfg, fetchFreshGeminiBuildLabel);
}

export function resetGeminiBuildLabelCacheForTest(): void {
	buildLabelCache.reset();
}

async function fetchFreshGeminiBuildLabel(cfg: RuntimeConfig): Promise<string> {
	try {
		const headers: Record<string, string> = {
			"User-Agent": GEMINI_WEB_USER_AGENT,
			"Accept-Language": "en-US,en;q=0.9",
		};
		if (cfg.cookie) headers.Cookie = cfg.cookie;
		const resp = await httpFetch(
			`${cfg.gemini_origin || "https://gemini.google.com"}/app`,
			{
				headers,
				timeoutMs: 30000,
				socket: cfg.upstream_socket,
				cfg,
			},
		);
		return await extractGeminiBuildLabel(resp);
	} catch (e) {
		log(cfg, `failed to refresh Gemini BL ${errorLogSummary(e)}`);
		return "";
	}
}

export async function refreshGeminiBuildLabelForRetry(
	cfg: RuntimeConfig,
	activeCfg: RuntimeConfig,
	alreadyRefreshed: boolean,
	context: string,
): Promise<RuntimeConfig | null> {
	if (alreadyRefreshed) return null;
	const freshBL = await getFreshGeminiBuildLabel(cfg);
	if (!freshBL || freshBL === activeCfg.gemini_bl) return null;
	const suffix = context ? ` ${context}` : "";
	log(cfg, `retrying${suffix} with refreshed GEMINI_BL=${freshBL}`);
	return { ...activeCfg, gemini_bl: freshBL };
}

export async function waitBeforeRetry(
	cfg: RuntimeConfig,
	attempt: number,
	error: unknown,
	label: string,
	signal: AbortSignal | null | undefined = undefined,
): Promise<boolean> {
	if (attempt >= Math.max(0, cfg.retry_attempts || 0) - 1) return false;
	log(
		cfg,
		`${label} ${attempt + 1}/${cfg.retry_attempts} ${errorLogSummary(error)}`,
	);
	await sleep(cfg.retry_delay_sec * 1000, signal);
	return true;
}
