// @ts-nocheck
import { describe, test } from "vitest";
import {
	createOriginScopedStringCache,
	geminiAccountCacheScope,
} from "../../../src/gemini/cache";
import { assert } from "../assertions.js";
import { withConsoleLog, withPatchedGlobal } from "../_support/globals.js";
import { createMemoryCache, withCaches } from "./_support/cache.js";

const CACHE_PREFIX = "https://internal-cache/test-metadata/";

function createMetadataCache(overrides = {}) {
	return createOriginScopedStringCache({
		cachePrefix: CACHE_PREFIX,
		ttlSec: 60,
		payloadKey: "value",
		logLabel: "test metadata",
		...overrides,
	});
}

function cacheConfig(overrides = {}) {
	return {
		gemini_origin: "https://gemini.example/",
		log_requests: false,
		...overrides,
	};
}

function accountConfig(accountId, cookieHash, overrides = {}) {
	return cacheConfig({
		gemini_account: { accountId, cookieHash },
		...overrides,
	});
}

function cacheRequest(scope) {
	return new Request(`${CACHE_PREFIX}${encodeURIComponent(scope)}`);
}

async function withNow(initialNow, run) {
	const originalNow = Date.now;
	let now = initialNow;
	Date.now = () => now;
	try {
		return await run((nextNow) => {
			now = nextNow;
		});
	} finally {
		Date.now = originalNow;
	}
}

describe("origin-scoped string cache", () => {
	test("derives origin and optional account cache scopes", () => {
		assert.equal(geminiAccountCacheScope({}), "https://gemini.google.com");
		assert.equal(
			geminiAccountCacheScope(cacheConfig()),
			"https://gemini.example",
		);
		assert.equal(
			geminiAccountCacheScope(accountConfig("account-a", "")),
			"https://gemini.example\0account:account-a\0cookie:",
		);
		assert.equal(
			geminiAccountCacheScope(accountConfig("", "hash-a")),
			"https://gemini.example\0account:\0cookie:hash-a",
		);
		assert.equal(
			geminiAccountCacheScope(accountConfig("account-a", "hash-a")),
			"https://gemini.example\0account:account-a\0cookie:hash-a",
		);
		assert.equal(
			geminiAccountCacheScope(accountConfig("  ", "  ")),
			"https://gemini.example",
		);
		assert.equal(
			geminiAccountCacheScope(accountConfig("account-a", "hash-a"), false),
			"https://gemini.example",
		);
	});

	test("keeps L1 entries bounded by least-recently-used order", async () => {
		const workerCache = createMemoryCache();
		const metadata = createMetadataCache({
			accountScoped: true,
			l1MaxEntries: 2,
		});
		const accountA = accountConfig("a", "ha");
		const accountB = accountConfig("b", "hb");
		const accountC = accountConfig("c", "hc");

		await withCaches(workerCache, async () => {
			await metadata.setCached(accountA, "value-a");
			await metadata.setCached(accountB, "value-b");
			assert.equal(await metadata.getCached(accountA), "value-a");
			await metadata.setCached(accountC, "value-c");

			assert.equal(await metadata.getCached(accountA), "value-a");
			assert.equal(workerCache.stats.match, 0);
			assert.equal(await metadata.getCached(accountB), "value-b");
			assert.equal(workerCache.stats.match, 1);

			metadata.reset();
			assert.equal(await metadata.getCached(accountC), "value-c");
			assert.equal(workerCache.stats.match, 2);
		});
	});

	test("expires L1 and deletes stale Workers Cache entries", async () => {
		const workerCache = createMemoryCache();
		const metadata = createMetadataCache();
		const cfg = cacheConfig();
		await withNow(1_000, async (setNow) => {
			await withCaches(workerCache, async () => {
				await metadata.setCached(cfg, "fresh");
				setNow(61_001);
				assert.equal(await metadata.getCached(cfg), "");
				assert.equal(workerCache.stats.match, 1);
				assert.equal(workerCache.stats.delete, 1);
			});
		});
	});

	test("puts gets and deletes values through the Workers Cache API", async () => {
		const workerCache = createMemoryCache();
		const metadata = createMetadataCache();
		const cfg = cacheConfig();
		await withCaches(workerCache, async () => {
			await metadata.setCached(cfg, "persisted");
			assert.equal(workerCache.stats.put, 1);

			metadata.reset();
			assert.equal(await metadata.getCached(cfg), "persisted");
			assert.equal(workerCache.stats.match, 1);

			await metadata.deleteCached(cfg);
			assert.equal(workerCache.stats.delete, 1);
			assert.equal(await metadata.getCached(cfg), "");
			assert.equal(workerCache.stats.match, 2);
		});
	});

	test("writes the exact cache URL payload and freshness headers", async () => {
		const writes = [];
		const workerCache = {
			async match() {
				return undefined;
			},
			async put(request, response) {
				writes.push({
					url: request.url,
					cacheControl: response.headers.get("cache-control"),
					contentType: response.headers.get("content-type"),
					payload: await response.json(),
				});
			},
			async delete() {
				return false;
			},
		};
		await withNow(12_345, async () => {
			await withCaches(workerCache, async () => {
				await createMetadataCache().setCached(cacheConfig(), "stored-value");
			});
		});
		assert.deepEqual(writes, [
			{
				url: "https://internal-cache/test-metadata/https%3A%2F%2Fgemini.example",
				cacheControl: "public, max-age=60",
				contentType: "application/json",
				payload: { value: "stored-value", created_at_ms: 12_345 },
			},
		]);
	});

	test("registers cache writes with executionContext.waitUntil", async () => {
		const workerCache = createMemoryCache();
		const metadata = createMetadataCache();
		const pending = [];
		await withCaches(workerCache, async () => {
			await metadata.setCached(
				cacheConfig({
					execution_ctx: {
						waitUntil(promise) {
							pending.push(promise);
						},
					},
				}),
				"deferred",
			);
			assert.equal(pending.length, 1);
			await Promise.all(pending);
			assert.equal(workerCache.stats.put, 1);
		});
	});

	test("degrades to L1 when Cache Storage or its default cache is absent", async () => {
		for (const cacheStorage of [undefined, {}]) {
			const metadata = createMetadataCache();
			const cfg = cacheConfig();
			await withPatchedGlobal("caches", cacheStorage, async () => {
				await metadata.setCached(cfg, "l1-only");
				assert.equal(await metadata.getCached(cfg), "l1-only");
				metadata.reset();
				assert.equal(await metadata.getCached(cfg), "");
				await metadata.deleteCached(cfg);
			});
		}
	});

	test("rejects malformed invalid and stale Workers Cache payloads", async () => {
		const cfg = cacheConfig();
		const scope = geminiAccountCacheScope(cfg, false);
		const payloads = [
			"{",
			JSON.stringify({ created_at_ms: Date.now() }),
			JSON.stringify({ value: "   ", created_at_ms: Date.now() }),
			JSON.stringify({ value: "present", created_at_ms: "invalid" }),
		];
		for (const payload of payloads) {
			const workerCache = createMemoryCache();
			await workerCache.put(cacheRequest(scope), new Response(payload));
			const metadata = createMetadataCache();
			await withCaches(workerCache, async () => {
				assert.equal(await metadata.getCached(cfg), "");
			});
		}

		const staleCache = createMemoryCache();
		await staleCache.put(
			cacheRequest(scope),
			new Response(
				JSON.stringify({
					value: "stale",
					created_at_ms: Date.now() - 61_000,
				}),
			),
		);
		await withCaches(staleCache, async () => {
			assert.equal(await createMetadataCache().getCached(cfg), "");
			assert.equal(staleCache.stats.delete, 1);
		});
	});

	test("contains Cache API rejections and emits sanitized diagnostics", async () => {
		const secretError = new Error("credential=must-not-leak");
		const rejectingCache = {
			async match() {
				throw secretError;
			},
			async put() {
				throw secretError;
			},
			async delete() {
				throw secretError;
			},
		};
		const metadata = createMetadataCache();
		const cfg = cacheConfig({ log_requests: true });
		const logs = [];
		await withCaches(rejectingCache, async () => {
			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					assert.equal(await metadata.getCached(cfg), "");
					await metadata.setCached(cfg, "value");
					await metadata.deleteCached(cfg);
				},
			);
		});
		assert.equal(logs.length, 3);
		assert.match(logs[0], /failed to read cached test metadata type=Error/);
		assert.match(logs[1], /failed to cache test metadata type=Error/);
		assert.match(logs[2], /failed to delete cached test metadata type=Error/);
		assert.doesNotMatch(logs.join("\n"), /must-not-leak/);
	});

	test("coalesces concurrent refreshes only within the same scope", async () => {
		const metadata = createMetadataCache({ accountScoped: true });
		const accountA = accountConfig("a", "ha");
		const accountB = accountConfig("b", "hb");
		let calls = 0;
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const fetchFresh = async (cfg) => {
			calls += 1;
			await gate;
			return `fresh-${cfg.gemini_account.accountId}`;
		};

		const firstA = metadata.getFresh(accountA, fetchFresh);
		const secondA = metadata.getFresh(accountA, fetchFresh);
		const firstB = metadata.getFresh(accountB, fetchFresh);
		release();
		assert.deepEqual(await Promise.all([firstA, secondA, firstB]), [
			"fresh-a",
			"fresh-a",
			"fresh-b",
		]);
		assert.equal(calls, 2);
	});

	test("releases a rejected refresh so the same scope can retry", async () => {
		const metadata = createMetadataCache();
		const cfg = cacheConfig();
		let calls = 0;
		await assert.rejects(
			() =>
				metadata.getFresh(cfg, async () => {
					calls += 1;
					throw new Error("refresh failed");
				}),
			/refresh failed/,
		);
		assert.equal(
			await metadata.getFresh(cfg, async () => {
				calls += 1;
				return "recovered";
			}),
			"recovered",
		);
		assert.equal(calls, 2);
	});

	test("does not cache blank or non-string values", async () => {
		const workerCache = createMemoryCache();
		const metadata = createMetadataCache();
		const cfg = cacheConfig();
		await withCaches(workerCache, async () => {
			for (const value of ["", "   ", null, undefined, 123])
				await metadata.setCached(cfg, value);
			assert.equal(workerCache.stats.put, 0);
			metadata.reset();
			assert.equal(await metadata.getCached(cfg), "");
		});
	});

	test("does not persist blank or non-string refresh results", async () => {
		const workerCache = createMemoryCache();
		const metadata = createMetadataCache();
		const cfg = cacheConfig();
		await withCaches(workerCache, async () => {
			for (const value of ["", "   ", null, undefined, 123]) {
				assert.equal(await metadata.getFresh(cfg, async () => value), "");
			}
		});
		assert.equal(workerCache.stats.put, 0);
	});
});
