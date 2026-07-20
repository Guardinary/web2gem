import { afterEach, beforeEach, describe, test } from "vitest";
import { uploadTextFile } from "../../../../src/gemini/uploads/execute";
import {
	getGeminiPushId,
	resetGeminiUploadCachesForTest,
} from "../../../../src/gemini/uploads/tokens";
import { isRecord } from "../../../../src/shared/types";
import { withConsoleLog, withFetch } from "../../_support/globals.js";
import { assert } from "../../assertions.js";
import { createMemoryCache, withCaches } from "../_support/cache.js";
import {
	assertMultipartRequest,
	baseUploadConfig,
	createUploadFetchRouter,
	resetUploadState,
	seedCachedPushId,
} from "./_support/upload-fixtures.js";

async function captureError(
	run: () => unknown | PromiseLike<unknown>,
): Promise<Record<string, unknown>> {
	try {
		await run();
	} catch (error) {
		if (isRecord(error)) return error;
		throw error;
	}
	throw new Error("expected operation to fail");
}

describe("Gemini push-token upload contract", () => {
	beforeEach(resetUploadState);
	afterEach(resetUploadState);

	test("uses a Workers-cached push ID without fetching the app page", async () => {
		const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
		const cache = createMemoryCache();
		await seedCachedPushId(cache, cfg, "push-upload-cache");
		const router = createUploadFetchRouter({
			contentPush: async (init) => {
				await assertMultipartRequest(init, {
					filename: "message.txt",
					mime: "text/plain; charset=utf-8",
					bodyText: "hello",
					pushId: "push-upload-cache",
				});
				return new Response("/uploaded/cached-text-ref", { status: 200 });
			},
		});
		await withCaches(cache, async () => {
			await withFetch(router.fetch, async () => {
				assert.deepEqual(await uploadTextFile(cfg, "hello", "message.txt"), {
					ref: "/uploaded/cached-text-ref",
					name: "message.txt",
				});
			});
		});
		assert.deepEqual(router.requests, [
			"https://content-push.googleapis.com/upload",
		]);
	});

	test("refreshes a stale push ID once for 401 403 and 415", async () => {
		for (const status of [401, 403, 415]) {
			resetUploadState();
			const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
			const cache = createMemoryCache();
			const pushIds: string[] = [];
			await seedCachedPushId(cache, cfg, `push-stale-${status}`);
			const router = createUploadFetchRouter({
				async contentPush(init) {
					pushIds.push(init.headers["Push-ID"] || "");
					await assertMultipartRequest(init, {
						filename: "message.txt",
						mime: "text/plain; charset=utf-8",
						bodyText: "hello",
					});
					return pushIds.length === 1
						? new Response("stale token", { status })
						: new Response(`/uploaded/refreshed-${status}`, { status: 200 });
				},
				app: () =>
					new Response(`{"qKIAYe":"push-fresh-${status}"}`, { status: 200 }),
			});
			await withCaches(cache, async () => {
				await withFetch(router.fetch, async () => {
					assert.deepEqual(await uploadTextFile(cfg, "hello", "message.txt"), {
						ref: `/uploaded/refreshed-${status}`,
						name: "message.txt",
					});
				});
				resetGeminiUploadCachesForTest();
				assert.equal(await getGeminiPushId(cfg), `push-fresh-${status}`);
			});
			assert.deepEqual(router.requests, [
				"https://content-push.googleapis.com/upload",
				"https://gemini.example/app",
				"https://content-push.googleapis.com/upload",
			]);
			assert.deepEqual(pushIds, [
				`push-stale-${status}`,
				`push-fresh-${status}`,
			]);
		}
	});

	test("does not refresh for unrelated upload status codes", async () => {
		const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
		const cache = createMemoryCache();
		await seedCachedPushId(cache, cfg, "push-current");
		const router = createUploadFetchRouter({
			contentPush: async (init) => {
				await assertMultipartRequest(init, {
					filename: "message.txt",
					mime: "text/plain; charset=utf-8",
					pushId: "push-current",
				});
				return new Response("upstream unavailable", { status: 500 });
			},
		});
		await withCaches(cache, async () => {
			await withFetch(router.fetch, async () => {
				const error = await captureError(() =>
					uploadTextFile(cfg, "hello", "message.txt"),
				);
				assert.equal(error.code, "content_push_http_status");
				assert.equal(error.status, 500);
				assert.equal(error.protocol, "multipart");
			});
		});
		assert.deepEqual(router.requests, [
			"https://content-push.googleapis.com/upload",
		]);
	});

	test("does not retry an upload when refresh returns the same push ID", async () => {
		const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
		const cache = createMemoryCache();
		await seedCachedPushId(cache, cfg, "push-same");
		const router = createUploadFetchRouter({
			contentPush: () => new Response("stale token", { status: 415 }),
			app: () => new Response('{"qKIAYe":"push-same"}', { status: 200 }),
		});
		await withCaches(cache, async () => {
			await withFetch(router.fetch, async () => {
				await assert.rejects(
					() => uploadTextFile(cfg, "hello", "message.txt"),
					/multipart upload failed with HTTP 415/,
				);
			});
		});
		assert.deepEqual(router.requests, [
			"https://content-push.googleapis.com/upload",
			"https://gemini.example/app",
		]);
	});

	test("rejects missing app-page markers without a fallback token", async () => {
		const logs: string[] = [];
		const router = createUploadFetchRouter({
			app: () => new Response("no token markers", { status: 200 }),
		});
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			() =>
				withFetch(router.fetch, async () => {
					const error = await captureError(() =>
						uploadTextFile(
							baseUploadConfig({
								cookie: "__Secure-1PSID=psid",
								log_requests: true,
							}),
							"hello",
							"message.txt",
						),
					);
					assert.equal(error.code, "content_push_missing_page_token");
					assert.equal(error.protocol, "multipart");
				}),
		);
		assert.deepEqual(router.requests, ["https://gemini.example/app"]);
		assert.equal(
			logs.some((line) => line.includes("app page push_id marker missing")),
			true,
		);
		assert.equal(
			logs.some((line) => line.includes("default page token")),
			false,
		);
	});
});
