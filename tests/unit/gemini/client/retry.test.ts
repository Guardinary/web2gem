// @ts-nocheck
import { afterEach, beforeEach, describe, test } from "vitest";
import { generate } from "../../../../src/gemini/client";
import {
	configWithCachedGeminiBuildLabel,
	GEMINI_BL_CACHE_TTL_SEC,
	getCachedGeminiBuildLabel,
	getFreshGeminiBuildLabel,
	resetGeminiBuildLabelCacheForTest,
	setCachedGeminiBuildLabel,
	waitBeforeRetry,
} from "../../../../src/gemini/client/retry";
import { assert } from "../../assertions.js";
import { withConsoleLog, withFetch } from "../../_support/globals.js";
import { createMemoryCache, withCaches } from "../_support/cache.js";
import { baseGeminiClientConfig } from "../_support/client-fixtures.js";

function accountConfig(base, accountId, cookieHash) {
	return {
		...base,
		gemini_account: {
			accountId,
			rowId: `row-${accountId}`,
			cookieHash,
		},
	};
}

describe("Gemini retry and build-label integration", () => {
	beforeEach(resetGeminiBuildLabelCacheForTest);
	afterEach(resetGeminiBuildLabelCacheForTest);

	test("honors retry attempt limits", async () => {
		const cfg = { retry_attempts: 2, retry_delay_sec: 0, log_requests: true };
		const err = new Error("boom secret");
		err.code = "retry_test";
		err.status = 502;
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			async () => {
				assert.equal(await waitBeforeRetry(cfg, 0, err, "Retry"), true);
				assert.equal(await waitBeforeRetry(cfg, 1, err, "Retry"), false);
			},
		);
		assert.deepEqual(logs, [
			"[web2gem] Retry 1/2 type=Error code=retry_test status=502",
		]);
		assert.doesNotMatch(logs[0], /boom secret/);
	});

	test("shares build labels across accounts at one origin without credential cache keys", async () => {
		const memory = createMemoryCache();
		const cacheRequests = [];
		const cache = {
			stats: memory.stats,
			async match(request) {
				cacheRequests.push(request.url);
				return memory.match(request);
			},
			async put(request, response) {
				cacheRequests.push(request.url);
				return memory.put(request, response);
			},
			async delete(request) {
				cacheRequests.push(request.url);
				return memory.delete(request);
			},
		};
		const first = accountConfig(
			baseGeminiClientConfig({
				gemini_bl: "configured-bl",
				cookie: "SID=raw-secret-a",
				sapisid: "sapisid-raw-secret-a",
			}),
			"account-a",
			"hash-a",
		);
		const second = accountConfig(
			baseGeminiClientConfig({
				gemini_bl: "configured-bl",
				cookie: "SID=raw-secret-b",
			}),
			"account-b",
			"hash-b",
		);
		const otherOrigin = accountConfig(
			baseGeminiClientConfig({ gemini_origin: "https://other.example" }),
			"account-c",
			"hash-c",
		);

		await withCaches(cache, async () => {
			await setCachedGeminiBuildLabel(first, "shared-bl");
			resetGeminiBuildLabelCacheForTest();
			assert.equal(await getCachedGeminiBuildLabel(second), "shared-bl");
			const active = await configWithCachedGeminiBuildLabel(second);
			assert.equal(active.gemini_bl, "shared-bl");
			assert.equal(second.gemini_bl, "configured-bl");
			assert.equal(await getCachedGeminiBuildLabel(otherOrigin), "");
		});

		assert.equal(cache.stats.put, 1);
		assert.equal(cache.stats.match, 2);
		assert.deepEqual(cacheRequests, [
			"https://internal-cache/gemini-bl/https%3A%2F%2Fgemini.example",
			"https://internal-cache/gemini-bl/https%3A%2F%2Fgemini.example",
			"https://internal-cache/gemini-bl/https%3A%2F%2Fother.example",
		]);
		assert.doesNotMatch(
			cacheRequests.join("\n"),
			/account-a|account-b|account-c|hash-a|hash-b|hash-c|raw-secret|SID|sapisid/,
		);
	});

	test("persists build labels with executionContext.waitUntil", async () => {
		const cache = createMemoryCache();
		const pending = [];
		await withCaches(cache, async () => {
			await setCachedGeminiBuildLabel(
				baseGeminiClientConfig({
					execution_ctx: {
						waitUntil(promise) {
							pending.push(promise);
						},
					},
				}),
				"waituntil-bl",
			);
			assert.equal(pending.length, 1);
			await Promise.all(pending);
			assert.equal(cache.stats.put, 1);
		});
	});

	test("drops stale cached build labels", async () => {
		const cfg = baseGeminiClientConfig();
		const cache = createMemoryCache();
		await cache.put(
			new Request(
				`https://internal-cache/gemini-bl/${encodeURIComponent("https://gemini.example")}`,
			),
			new Response(
				JSON.stringify({
					gemini_bl: "stale-bl",
					created_at_ms: Date.now() - (GEMINI_BL_CACHE_TTL_SEC * 1000 + 1),
				}),
			),
		);
		await withCaches(cache, async () => {
			assert.equal(await getCachedGeminiBuildLabel(cfg), "");
			assert.equal(cache.stats.delete, 1);
		});
	});

	test("coalesces build-label refreshes across accounts at one origin", async () => {
		const first = accountConfig(
			baseGeminiClientConfig({ cookie: "SID=first" }),
			"first",
			"hash-first",
		);
		const second = accountConfig(
			baseGeminiClientConfig({ cookie: "SID=second" }),
			"second",
			"hash-second",
		);
		const cache = createMemoryCache();
		let calls = 0;
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		await withCaches(cache, async () => {
			await withFetch(
				async (url, init) => {
					calls += 1;
					assert.equal(String(url), "https://gemini.example/app");
					assert.equal(init.headers.Cookie, "SID=first");
					await gate;
					return new Response('<script>{"cfb2h":"fresh-bl"}</script>', {
						status: 200,
					});
				},
				async () => {
					const firstRefresh = getFreshGeminiBuildLabel(first);
					const secondRefresh = getFreshGeminiBuildLabel(second);
					release();
					assert.deepEqual(await Promise.all([firstRefresh, secondRefresh]), [
						"fresh-bl",
						"fresh-bl",
					]);
				},
			);
		});
		assert.equal(calls, 1);
	});

	test("does not spend generic retry attempts on managed accounts", async () => {
		const cfg = accountConfig(
			baseGeminiClientConfig({ retry_attempts: 3 }),
			"managed-retry",
			"hash",
		);
		let fetchCalls = 0;
		await withFetch(
			async (url) => {
				fetchCalls += 1;
				assert.match(String(url), /StreamGenerate/);
				throw new Error("network failed");
			},
			async () => {
				await assert.rejects(
					() => generate(cfg, "prompt", 1, false, null),
					/network failed/,
				);
			},
		);
		assert.equal(fetchCalls, 1);
	});
});
