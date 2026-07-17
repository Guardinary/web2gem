import { afterEach, beforeEach, describe, test } from "vitest";
import { uploadTextFile } from "../../../../src/gemini/uploads/execute";
import {
	getCachedGeminiPushId,
	resetGeminiUploadCachesForTest,
	setCachedGeminiPushId,
} from "../../../../src/gemini/uploads/tokens";
import { assert } from "../../assertions.js";
import {
	createMemoryCache,
	withCaches,
	withConsoleLog,
	withFetch,
} from "../../helpers.js";
import {
	assertMultipartRequest,
	baseUploadConfig,
	resetUploadState,
} from "./_support/upload-fixtures.js";

async function captureError(run) {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected operation to fail");
}

describe("Gemini push-token upload contract", () => {
	beforeEach(resetUploadState);
	afterEach(resetUploadState);

	test("uses a Workers-cached push ID without fetching the app page", async () => {
		const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
		const cache = createMemoryCache();
		const requests = [];
		await withCaches(cache, async () => {
			await setCachedGeminiPushId(cfg, "push-upload-cache");
			resetGeminiUploadCachesForTest();
			await withFetch(
				async (url, init = {}) => {
					const href = String(url);
					requests.push(href);
					if (href !== "https://content-push.googleapis.com/upload") {
						throw new Error(`unexpected fetch ${href}`);
					}
					await assertMultipartRequest(init, {
						filename: "message.txt",
						mime: "text/plain; charset=utf-8",
						bodyText: "hello",
						pushId: "push-upload-cache",
					});
					return new Response("/uploaded/cached-text-ref", { status: 200 });
				},
				async () => {
					assert.deepEqual(await uploadTextFile(cfg, "hello", "message.txt"), {
						ref: "/uploaded/cached-text-ref",
						name: "message.txt",
					});
				},
			);
		});
		assert.deepEqual(requests, ["https://content-push.googleapis.com/upload"]);
	});

	test("refreshes a stale push ID once for 401 403 and 415", async () => {
		for (const status of [401, 403, 415]) {
			resetUploadState();
			const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
			const cache = createMemoryCache();
			const requests = [];
			const pushIds = [];
			await withCaches(cache, async () => {
				await setCachedGeminiPushId(cfg, `push-stale-${status}`);
				resetGeminiUploadCachesForTest();
				await withFetch(
					async (url, init = {}) => {
						const href = String(url);
						requests.push(href);
						if (href === "https://content-push.googleapis.com/upload") {
							pushIds.push(init.headers["Push-ID"]);
							await assertMultipartRequest(init, {
								filename: "message.txt",
								mime: "text/plain; charset=utf-8",
								bodyText: "hello",
							});
							return pushIds.length === 1
								? new Response("stale token", { status })
								: new Response(`/uploaded/refreshed-${status}`, {
										status: 200,
									});
						}
						if (href === "https://gemini.example/app") {
							return new Response(`{"qKIAYe":"push-fresh-${status}"}`, {
								status: 200,
							});
						}
						throw new Error(`unexpected fetch ${href}`);
					},
					async () => {
						assert.deepEqual(
							await uploadTextFile(cfg, "hello", "message.txt"),
							{ ref: `/uploaded/refreshed-${status}`, name: "message.txt" },
						);
					},
				);
				assert.equal(await getCachedGeminiPushId(cfg), `push-fresh-${status}`);
			});
			assert.deepEqual(requests, [
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
		const requests = [];
		await withCaches(cache, async () => {
			await setCachedGeminiPushId(cfg, "push-current");
			resetGeminiUploadCachesForTest();
			await withFetch(
				async (url, init = {}) => {
					const href = String(url);
					requests.push(href);
					assert.equal(href, "https://content-push.googleapis.com/upload");
					await assertMultipartRequest(init, {
						filename: "message.txt",
						mime: "text/plain; charset=utf-8",
						pushId: "push-current",
					});
					return new Response("upstream unavailable", { status: 500 });
				},
				async () => {
					const error = await captureError(() =>
						uploadTextFile(cfg, "hello", "message.txt"),
					);
					assert.equal(error.code, "content_push_http_status");
					assert.equal(error.status, 500);
					assert.equal(error.protocol, "multipart");
				},
			);
		});
		assert.deepEqual(requests, ["https://content-push.googleapis.com/upload"]);
	});

	test("does not retry an upload when refresh returns the same push ID", async () => {
		const cfg = baseUploadConfig({ cookie: "__Secure-1PSID=psid" });
		const cache = createMemoryCache();
		const requests = [];
		await withCaches(cache, async () => {
			await setCachedGeminiPushId(cfg, "push-same");
			resetGeminiUploadCachesForTest();
			await withFetch(
				async (url) => {
					const href = String(url);
					requests.push(href);
					if (href === "https://content-push.googleapis.com/upload") {
						return new Response("stale token", { status: 415 });
					}
					if (href === "https://gemini.example/app") {
						return new Response('{"qKIAYe":"push-same"}', { status: 200 });
					}
					throw new Error(`unexpected fetch ${href}`);
				},
				async () => {
					await assert.rejects(
						() => uploadTextFile(cfg, "hello", "message.txt"),
						/multipart upload failed with HTTP 415/,
					);
				},
			);
		});
		assert.deepEqual(requests, [
			"https://content-push.googleapis.com/upload",
			"https://gemini.example/app",
		]);
	});

	test("rejects missing app-page markers without a fallback token", async () => {
		const logs = [];
		const requests = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				withFetch(
					async (url) => {
						const href = String(url);
						requests.push(href);
						if (href === "https://gemini.example/app") {
							return new Response("no token markers", { status: 200 });
						}
						throw new Error(`unexpected fetch ${href}`);
					},
					async () => {
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
					},
				),
		);
		assert.deepEqual(requests, ["https://gemini.example/app"]);
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
