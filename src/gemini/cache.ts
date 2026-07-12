import type { RuntimeConfig } from "../config";
import { errorLogSummary } from "../shared/errors";
import { log } from "../shared/logging";

type OriginScopedStringCacheOptions = {
	cachePrefix: string;
	ttlSec: number;
	payloadKey: string;
	logLabel: string;
	accountScoped?: boolean;
	l1MaxEntries?: number;
};

type OriginScopedStringCachePayload = Record<string, unknown> & {
	created_at_ms?: unknown;
};

function geminiOrigin(cfg: RuntimeConfig): string {
	return (cfg.gemini_origin || "https://gemini.google.com").replace(/\/$/, "");
}

export function geminiAccountCacheScope(
	cfg: RuntimeConfig,
	accountScoped = true,
): string {
	const origin = geminiOrigin(cfg);
	if (!accountScoped) return origin;
	const account = cfg.gemini_account;
	if (!account) return origin;
	const accountId = String(account.accountId || "").trim();
	const cookieHash = String(account.cookieHash || "").trim();
	if (!accountId && !cookieHash) return origin;
	return `${origin}\x00account:${accountId}\x00cookie:${cookieHash}`;
}

function workerCache(): Cache | null {
	if (typeof caches === "undefined") return null;
	const cacheStorage = caches as CacheStorage & { default?: Cache };
	return cacheStorage.default || null;
}

export function createOriginScopedStringCache(
	options: OriginScopedStringCacheOptions,
) {
	const refreshes = new Map<string, Promise<string>>();
	const l1 = new Map<string, { value: string; expiresAt: number }>();
	const l1MaxEntries = positiveInt(options.l1MaxEntries, 32);

	const cacheKey = (scope: string): Request =>
		new Request(`${options.cachePrefix}${encodeURIComponent(scope)}`);

	const setL1 = (
		scope: string,
		value: string,
		now: number = Date.now(),
	): void => {
		l1.delete(scope);
		l1.set(scope, {
			value,
			expiresAt: now + options.ttlSec * 1000,
		});
		while (l1.size > l1MaxEntries) {
			const oldestScope = l1.keys().next().value;
			if (oldestScope === undefined) break;
			l1.delete(oldestScope);
		}
	};

	const clearL1 = (scope?: string): void => {
		if (scope) l1.delete(scope);
		else l1.clear();
	};

	const put = (
		cfg: RuntimeConfig,
		scope: string,
		value: string,
		now: number,
	): Promise<void> => {
		const cache = workerCache();
		if (!cache) return Promise.resolve();
		return cache
			.put(
				cacheKey(scope),
				new Response(
					JSON.stringify({
						[options.payloadKey]: value,
						created_at_ms: now,
					}),
					{
						headers: {
							"Content-Type": "application/json",
							"Cache-Control": `public, max-age=${options.ttlSec}`,
						},
					},
				),
			)
			.catch((e) => {
				logCacheError(cfg, `failed to cache ${options.logLabel}`, e);
			});
	};

	const getCached = async (cfg: RuntimeConfig): Promise<string> => {
		const scope = geminiAccountCacheScope(cfg, !!options.accountScoped);
		const now = Date.now();
		const cached = l1.get(scope);
		if (cached && cached.expiresAt > now) {
			l1.delete(scope);
			l1.set(scope, cached);
			return cached.value;
		}
		clearL1(scope);
		const cache = workerCache();
		if (!cache) return "";
		try {
			const resp = await cache.match(cacheKey(scope));
			if (!resp) return "";
			const data = (await resp
				.json()
				.catch(() => null)) as OriginScopedStringCachePayload | null;
			const value = validString(data?.[options.payloadKey]);
			const createdAt = Number(data?.created_at_ms);
			if (!value || !Number.isFinite(createdAt)) return "";
			if (now - createdAt > options.ttlSec * 1000) {
				await cache.delete(cacheKey(scope)).catch(() => false);
				return "";
			}
			setL1(scope, value, createdAt);
			return value;
		} catch (e) {
			logCacheError(cfg, `failed to read cached ${options.logLabel}`, e);
			return "";
		}
	};

	const deleteCached = async (cfg: RuntimeConfig): Promise<void> => {
		const scope = geminiAccountCacheScope(cfg, !!options.accountScoped);
		clearL1(scope);
		const cache = workerCache();
		if (!cache) return;
		await cache.delete(cacheKey(scope)).catch(() => false);
	};

	const setCached = async (
		cfg: RuntimeConfig,
		rawValue: string,
	): Promise<void> => {
		const value = validString(rawValue);
		if (!value) return;
		const scope = geminiAccountCacheScope(cfg, !!options.accountScoped);
		const now = Date.now();
		setL1(scope, value, now);
		const write = put(cfg, scope, value, now);
		if (cfg.execution_ctx) {
			cfg.execution_ctx.waitUntil(write);
			return;
		}
		await write;
	};

	const getFresh = async (
		cfg: RuntimeConfig,
		fetchFresh: (cfg: RuntimeConfig) => Promise<string>,
	): Promise<string> => {
		const refreshKey = geminiAccountCacheScope(cfg, !!options.accountScoped);
		const pending = refreshes.get(refreshKey);
		if (pending) return pending;

		const refresh = (async () => {
			const value = validString(await fetchFresh(cfg));
			if (value) await setCached(cfg, value);
			return value;
		})();
		refreshes.set(refreshKey, refresh);
		try {
			return await refresh;
		} finally {
			refreshes.delete(refreshKey);
		}
	};

	return {
		getCached,
		setCached,
		deleteCached,
		getFresh,
		reset(): void {
			clearL1();
			refreshes.clear();
		},
	};
}

function validString(value: unknown): string {
	const text = typeof value === "string" ? value.trim() : "";
	return text ? text : "";
}

function positiveInt(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && Number(value) > 0
		? Number(value)
		: fallback;
}

function logCacheError(
	cfg: RuntimeConfig,
	prefix: string,
	error: unknown,
): void {
	log(cfg, `${prefix} ${errorLogSummary(error)}`);
}
