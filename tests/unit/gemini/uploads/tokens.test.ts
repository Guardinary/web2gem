import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { RuntimeConfig } from "../../../../src/config";
import {
	getFreshPageTokensForConfig,
	getGeminiPushId,
	getPageTokens,
	resetGeminiUploadCachesForTest,
} from "../../../../src/gemini/uploads/tokens";
import { withFetch } from "../../_support/globals.js";
import { assert } from "../../assertions.js";
import { createMemoryCache, withCaches } from "../_support/cache.js";
import {
	accountUploadConfig,
	baseUploadConfig,
	resetUploadState,
	seedCachedPushId,
} from "./_support/upload-fixtures.js";

type MemoryCache = ReturnType<typeof createMemoryCache>;
type FetchInit = RequestInit & { headers: Record<string, string> };

function recordingMemoryCache(): {
	requestUrls: string[];
	cache: MemoryCache;
} {
	const delegate = createMemoryCache();
	const requestUrls: string[] = [];
	return {
		requestUrls,
		cache: {
			stats: delegate.stats,
			async match(request: Request) {
				requestUrls.push(request.url);
				return delegate.match(request);
			},
			async put(request: Request, response: Response) {
				requestUrls.push(request.url);
				return delegate.put(request, response);
			},
			async delete(request: Request) {
				requestUrls.push(request.url);
				return delegate.delete(request);
			},
		},
	};
}

describe("Gemini upload tokens", () => {
	beforeEach(resetUploadState);
	afterEach(() => {
		resetUploadState();
		vi.useRealTimers();
	});
	test("caches Gemini push IDs in the Workers cache API", async () => {
		const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
		const cache = createMemoryCache();
		await seedCachedPushId(cache, cfg, "push-cached");
		await withCaches(cache, async () => {
			assert.equal(await getGeminiPushId(cfg), "push-cached");
			assert.equal(cache.stats.match, 1);

			resetGeminiUploadCachesForTest();
			assert.equal(await getGeminiPushId(cfg), "push-cached");
			assert.equal(cache.stats.match, 2);
		});
	});
	test("scopes Gemini push ID cache by account context when present", async () => {
		const cfgA = accountUploadConfig("account-a", "hash-a");
		const cfgB = accountUploadConfig("account-b", "hash-b");
		const { cache, requestUrls } = recordingMemoryCache();
		await seedCachedPushId(cache, cfgA, "push-a");
		await seedCachedPushId(cache, cfgB, "push-b");
		await withCaches(cache, async () => {
			assert.equal(await getGeminiPushId(cfgA), "push-a");
			assert.equal(await getGeminiPushId(cfgB), "push-b");
		});
		assert.equal(new Set(requestUrls).size, 2);
		assert.doesNotMatch(
			requestUrls.join("\n"),
			/psid-account-a|ts-account-a|psid-account-b|ts-account-b/,
		);
	});
	test("uses the 12-hour push-ID freshness window", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_700_000_000_000);
		const cfg = baseUploadConfig();
		const cache = createMemoryCache();
		await seedCachedPushId(
			cache,
			cfg,
			"still-fresh",
			Date.now() - (12 * 60 * 60 * 1000 - 1),
		);
		await withCaches(cache, async () => {
			assert.equal(await getGeminiPushId(cfg), "still-fresh");
			resetGeminiUploadCachesForTest();
			await seedCachedPushId(
				cache,
				cfg,
				"stale",
				Date.now() - (12 * 60 * 60 * 1000 + 1),
			);
			await withFetch(
				async () => new Response('{"qKIAYe":"after-stale"}', { status: 200 }),
				async () => {
					assert.equal(await getGeminiPushId(cfg), "after-stale");
				},
			);
			assert.equal(cache.stats.delete, 1);
		});
	});
	test("refreshes Gemini push IDs once for concurrent callers", async () => {
		const cfg = baseUploadConfig({ cookie: "SID=ok" });
		const cache = createMemoryCache();
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await withCaches(cache, async () => {
			await withFetch(
				async (url: RequestInfo | URL, init = {} as FetchInit) => {
					calls += 1;
					assert.equal(String(url), "https://gemini.example/app");
					assert.equal(init.headers.Cookie, "SID=ok");
					await gate;
					return new Response('{"qKIAYe":"push-fresh"}', { status: 200 });
				},
				async () => {
					const first = getGeminiPushId(cfg);
					const second = getGeminiPushId(cfg);
					release();
					assert.deepEqual(await Promise.all([first, second]), [
						"push-fresh",
						"push-fresh",
					]);
					assert.equal(calls, 1);
					resetGeminiUploadCachesForTest();
					assert.equal(await getGeminiPushId(cfg), "push-fresh");
				},
			);
		});
	});
	test("deduplicates concurrent page-token fetches by cache key", async () => {
		const cfg = baseUploadConfig({ cookie: "SID=page-token" });
		let appCalls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await withFetch(
			async (url: RequestInfo | URL) => {
				assert.equal(String(url), "https://gemini.example/app");
				appCalls += 1;
				await gate;
				return new Response('{"SNlM0e":"at-shared"}', { status: 200 });
			},
			async () => {
				const first = getPageTokens(cfg);
				const second = getPageTokens(cfg);
				release();
				assert.deepEqual(await Promise.all([first, second]), [
					{ at: "at-shared" },
					{ at: "at-shared" },
				]);
			},
		);
		assert.equal(appCalls, 1);
	});

	test("short-caches successful app pages without token markers", async () => {
		let appCalls = 0;
		await withFetch(
			async (url: RequestInfo | URL) => {
				assert.equal(String(url), "https://gemini.example/app");
				appCalls += 1;
				return new Response("no token markers", { status: 200 });
			},
			async () => {
				assert.deepEqual(await getPageTokens(baseUploadConfig()), {});
				assert.deepEqual(await getPageTokens(baseUploadConfig()), {});
			},
		);
		assert.equal(appCalls, 1);
	});
	test("does not cache page-token fetch failures as successful empty token results", async () => {
		let appCalls = 0;
		await withFetch(
			async (url: RequestInfo | URL) => {
				const href = String(url);
				if (href === "https://gemini.example/app") {
					appCalls += 1;
					throw new Error("app unavailable");
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				assert.deepEqual(await getPageTokens(baseUploadConfig()), {});
				assert.deepEqual(await getPageTokens(baseUploadConfig()), {});
			},
		);
		assert.equal(appCalls, 2);
	});
	test("bypasses the page-token cache for forced Gemini session verification", async () => {
		let appCalls = 0;
		const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
		await withFetch(
			async (url: RequestInfo | URL) => {
				if (String(url) !== "https://gemini.example/app")
					throw new Error(`unexpected fetch ${url}`);
				appCalls += 1;
				return new Response(`{"SNlM0e":"at-${appCalls}"}`, { status: 200 });
			},
			async () => {
				assert.deepEqual(await getPageTokens(cfg), { at: "at-1" });
				assert.deepEqual(await getPageTokens(cfg), { at: "at-1" });
				assert.deepEqual(await getFreshPageTokensForConfig(cfg), {
					at: "at-2",
				});
			},
		);
		assert.equal(appCalls, 2);
	});
	test("observes managed account cookies from app page responses", async () => {
		const observed: string[][] = [];
		const base = accountUploadConfig("observed", "hash-observed");
		const cfg: RuntimeConfig = {
			...base,
			gemini_account: {
				accountId: "observed",
				cookieHash: "hash-observed",
				observeSetCookie(values: readonly string[]) {
					observed.push([...values]);
				},
			},
		};
		await withFetch(
			async (url: RequestInfo | URL) => {
				assert.equal(String(url), "https://gemini.example/app");
				return new Response('{"SNlM0e":"fresh-at"}', {
					status: 200,
					headers: {
						"set-cookie": "__Secure-1PSIDTS=from-app; Path=/; Secure",
					},
				});
			},
			async () => {
				assert.deepEqual(await getFreshPageTokensForConfig(cfg), {
					at: "fresh-at",
				});
			},
		);
		assert.equal(observed.length, 1);
		assert.match(observed[0]?.[0] ?? "", /from-app/);
	});
	test("scopes Gemini page tokens by account context", async () => {
		const cfgA = accountUploadConfig("account-a", "hash-a");
		const cfgB = accountUploadConfig("account-b", "hash-b");
		const appCookies: string[] = [];
		await withFetch(
			async (url: RequestInfo | URL, init = {} as FetchInit) => {
				const href = String(url);
				if (href === "https://gemini.example/app") {
					const cookie = init.headers.Cookie || "";
					appCookies.push(cookie);
					if (cookie.includes("psid-account-a")) {
						return new Response('{"SNlM0e":"at-a","qKIAYe":"push-a"}', {
							status: 200,
						});
					}
					if (cookie.includes("psid-account-b")) {
						return new Response('{"SNlM0e":"at-b","qKIAYe":"push-b"}', {
							status: 200,
						});
					}
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				assert.deepEqual(await getPageTokens(cfgA), {
					at: "at-a",
					push_id: "push-a",
				});
				assert.deepEqual(await getPageTokens(cfgB), {
					at: "at-b",
					push_id: "push-b",
				});
				assert.deepEqual(await getPageTokens(cfgA), {
					at: "at-a",
					push_id: "push-a",
				});
			},
		);
		assert.deepEqual(appCookies, [
			"__Secure-1PSID=psid-account-a; __Secure-1PSIDTS=ts-account-a",
			"__Secure-1PSID=psid-account-b; __Secure-1PSIDTS=ts-account-b",
			"__Secure-1PSID=psid-account-a; __Secure-1PSIDTS=ts-account-a",
		]);
	});
});
