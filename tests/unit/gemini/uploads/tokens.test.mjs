import { afterEach, beforeEach, describe, test } from "vitest";
import {
	getCachedGeminiPushId,
	getFreshPageTokensForConfig,
	getGeminiPushId,
	getPageTokens,
	resetGeminiUploadCachesForTest,
	setCachedGeminiPushId,
} from "../../../../src/gemini/uploads/tokens";
import { assert } from "../../assertions.js";
import { createMemoryCache, withCaches, withFetch } from "../../helpers.js";
import {
	accountUploadConfig,
	baseUploadConfig,
	resetUploadState,
} from "./_support/upload-fixtures.js";

function recordingMemoryCache() {
	const delegate = createMemoryCache();
	const requestUrls = [];
	return {
		requestUrls,
		cache: {
			stats: delegate.stats,
			async match(request) {
				requestUrls.push(request.url);
				return delegate.match(request);
			},
			async put(request, response) {
				requestUrls.push(request.url);
				return delegate.put(request, response);
			},
			async delete(request) {
				requestUrls.push(request.url);
				return delegate.delete(request);
			},
		},
	};
}

describe("Gemini upload tokens", () => {
	beforeEach(resetUploadState);
	afterEach(resetUploadState);
	test("caches Gemini push IDs in the Workers cache API", async () => {
		const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
		const cache = createMemoryCache();
		await withCaches(cache, async () => {
			assert.equal(await getCachedGeminiPushId(cfg), "");
			await setCachedGeminiPushId(cfg, "push-cached");
			assert.equal(await getCachedGeminiPushId(cfg), "push-cached");
			assert.equal(cache.stats.match, 1);

			resetGeminiUploadCachesForTest();
			assert.equal(await getCachedGeminiPushId(cfg), "push-cached");
			assert.equal(cache.stats.match, 2);
		});
	});
	test("persists Gemini push IDs with waitUntil when available", async () => {
		const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
		const cache = createMemoryCache();
		const pending = [];
		await withCaches(cache, async () => {
			await setCachedGeminiPushId(
				{
					...cfg,
					execution_ctx: {
						waitUntil(promise) {
							pending.push(promise);
						},
					},
				},
				"push-waituntil",
			);
			assert.equal(await getCachedGeminiPushId(cfg), "push-waituntil");
			assert.equal(cache.stats.match, 0);
			assert.equal(pending.length, 1);
			await Promise.all(pending);
			assert.equal(cache.stats.put, 1);
		});
	});
	test("scopes Gemini push ID cache by account context when present", async () => {
		const cfgA = accountUploadConfig("account-a", "hash-a");
		const cfgB = accountUploadConfig("account-b", "hash-b");
		const { cache, requestUrls } = recordingMemoryCache();
		await withCaches(cache, async () => {
			await setCachedGeminiPushId(cfgA, "push-a");
			await setCachedGeminiPushId(cfgB, "push-b");
			resetGeminiUploadCachesForTest();
			assert.equal(await getCachedGeminiPushId(cfgA), "push-a");
			assert.equal(await getCachedGeminiPushId(cfgB), "push-b");
		});
		assert.equal(new Set(requestUrls).size, 2);
		assert.doesNotMatch(
			requestUrls.join("\n"),
			/psid-account-a|ts-account-a|psid-account-b|ts-account-b/,
		);
	});
	test("drops stale cached Gemini push IDs", async () => {
		const cfg = baseUploadConfig();
		const cache = createMemoryCache();
		await cache.put(
			new Request(
				`https://internal-cache/gemini-push-id/${encodeURIComponent("https://gemini.example")}`,
			),
			new Response(
				JSON.stringify({
					push_id: "stale-push-id",
					created_at_ms: Date.now() - 13 * 60 * 60 * 1000,
				}),
			),
		);
		await withCaches(cache, async () => {
			assert.equal(await getCachedGeminiPushId(cfg), "");
			assert.equal(await getCachedGeminiPushId(cfg), "");
			assert.equal(cache.stats.delete, 1);
		});
	});
	test("refreshes Gemini push IDs once for concurrent callers", async () => {
		const cfg = baseUploadConfig({ cookie: "SID=ok" });
		const cache = createMemoryCache();
		let calls = 0;
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		await withCaches(cache, async () => {
			await withFetch(
				async (url, init = {}) => {
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
					assert.equal(await getCachedGeminiPushId(cfg), "push-fresh");
				},
			);
		});
	});
	test("deduplicates concurrent page-token fetches by cache key", async () => {
		const cfg = baseUploadConfig({ cookie: "SID=page-token" });
		let appCalls = 0;
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		await withFetch(
			async (url) => {
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
			async (url) => {
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
			async (url) => {
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
			async (url) => {
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
	test("scopes Gemini page tokens by account context", async () => {
		const cfgA = accountUploadConfig("account-a", "hash-a");
		const cfgB = accountUploadConfig("account-b", "hash-b");
		const appCookies = [];
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				if (href === "https://gemini.example/app") {
					appCookies.push(init.headers.Cookie);
					if (init.headers.Cookie.includes("psid-account-a")) {
						return new Response('{"SNlM0e":"at-a","qKIAYe":"push-a"}', {
							status: 200,
						});
					}
					if (init.headers.Cookie.includes("psid-account-b")) {
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
