import { afterEach, beforeEach, describe, test } from "vitest";
import type { RuntimeConfig } from "../../../../src/config";
import { generate } from "../../../../src/gemini/client";
import {
	configWithCachedGeminiBuildLabel,
	getFreshGeminiBuildLabel,
	resetGeminiBuildLabelCacheForTest,
	waitBeforeRetry,
} from "../../../../src/gemini/client/retry";
import { withConsoleLog, withFetch } from "../../_support/globals.js";
import { assert } from "../../assertions.js";
import { createMemoryCache, withCaches } from "../_support/cache.js";
import { baseGeminiClientConfig } from "../_support/client-fixtures.js";

const BUILD_LABEL_CACHE_PREFIX = "https://internal-cache/gemini-bl/";

function buildLabelCacheRequest(origin: string): Request {
	return new Request(
		`${BUILD_LABEL_CACHE_PREFIX}${encodeURIComponent(origin)}`,
	);
}

function buildLabelCacheResponse(
	buildLabel: string,
	createdAtMs: number = Date.now(),
): Response {
	return new Response(
		JSON.stringify({ gemini_bl: buildLabel, created_at_ms: createdAtMs }),
	);
}

function accountConfig(
	base: RuntimeConfig,
	accountId: string,
	cookieHash: string,
): RuntimeConfig {
	return {
		...base,
		gemini_account: {
			accountId,
			cookieHash,
		},
	};
}

describe("Gemini retry and build-label integration", () => {
	beforeEach(resetGeminiBuildLabelCacheForTest);
	afterEach(resetGeminiBuildLabelCacheForTest);

	test("honors retry attempt limits", async () => {
		const cfg = baseGeminiClientConfig({
			retry_attempts: 2,
			retry_delay_sec: 0,
			log_requests: true,
		});
		const err = Object.assign(new Error("boom secret"), {
			code: "retry_test",
			status: 502,
		});
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
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
		const cacheRequests: string[] = [];
		const cache = {
			stats: memory.stats,
			async match(request: Request) {
				cacheRequests.push(request.url);
				return memory.match(request);
			},
			async put(request: Request, response: Response) {
				cacheRequests.push(request.url);
				return memory.put(request, response);
			},
			async delete(request: Request) {
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

		await cache.put(
			buildLabelCacheRequest(first.gemini_origin),
			buildLabelCacheResponse("shared-bl"),
		);
		await withCaches(cache, async () => {
			resetGeminiBuildLabelCacheForTest();
			const active = await configWithCachedGeminiBuildLabel(second);
			assert.equal(active.gemini_bl, "shared-bl");
			assert.equal(second.gemini_bl, "configured-bl");
			const otherActive = await configWithCachedGeminiBuildLabel(otherOrigin);
			assert.equal(otherActive.gemini_bl, otherOrigin.gemini_bl);
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
		const pending: Promise<unknown>[] = [];
		await withCaches(cache, async () => {
			await withFetch(
				async () => new Response('<script>{"cfb2h":"waituntil-bl"}</script>'),
				async () => {
					assert.equal(
						await getFreshGeminiBuildLabel(
							baseGeminiClientConfig({
								execution_ctx: {
									waitUntil(promise) {
										pending.push(promise);
									},
								},
							}),
						),
						"waituntil-bl",
					);
				},
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
			buildLabelCacheRequest("https://gemini.example"),
			buildLabelCacheResponse("stale-bl", 0),
		);
		await withCaches(cache, async () => {
			const active = await configWithCachedGeminiBuildLabel(cfg);
			assert.equal(active.gemini_bl, cfg.gemini_bl);
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
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await withCaches(cache, async () => {
			await withFetch(
				async (
					url: string | URL | Request,
					init: { headers: Record<string, string> },
				) => {
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
			async (url: unknown) => {
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
