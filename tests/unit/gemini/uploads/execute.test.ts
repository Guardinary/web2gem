import { afterEach, beforeEach, describe, test } from "vitest";
import type { ContentPushUploadError } from "../../../../src/gemini/uploads/errors";
import { uploadTextFile } from "../../../../src/gemini/uploads/execute";
import { withFetch } from "../../_support/globals.js";
import { assert } from "../../assertions.js";
import {
	assertMultipartRequest,
	baseUploadConfig,
	createUploadFetchRouter,
	resetUploadState,
} from "./_support/upload-fixtures.js";

function isContentPushUploadError(
	error: unknown,
): error is ContentPushUploadError {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return (
		error.code === "content_push_http_status" ||
		error.code === "content_push_invalid_ref" ||
		error.code === "content_push_missing_page_token"
	);
}

async function captureError(
	run: () => unknown | PromiseLike<unknown>,
): Promise<ContentPushUploadError> {
	try {
		await run();
	} catch (error) {
		if (isContentPushUploadError(error)) return error;
		throw error;
	}
	throw new Error("expected operation to fail");
}

describe("required Gemini uploads", () => {
	beforeEach(resetUploadState);
	afterEach(resetUploadState);

	test("uploads required text through unauthenticated multipart transport", async () => {
		const router = createUploadFetchRouter({
			app: () => new Response('{"qKIAYe":"push-text"}', { status: 200 }),
			async contentPush(init) {
				await assertMultipartRequest(init, {
					filename: "message.txt",
					mime: "text/plain; charset=utf-8",
					bodyText: "hello",
					pushId: "push-text",
				});
				return new Response("/uploaded/text-ref", { status: 200 });
			},
		});
		await withFetch(router.fetch, async () => {
			assert.deepEqual(
				await uploadTextFile(
					baseUploadConfig({
						cookie: "__Secure-1PSID=psid; SAPISID=sapi",
						sapisid: "sapi",
					}),
					"hello",
					"message.txt",
				),
				{ ref: "/uploaded/text-ref", name: "message.txt" },
			);
		});
		assert.deepEqual(router.requests, [
			"https://gemini.example/app",
			"https://content-push.googleapis.com/upload",
		]);
	});

	test("keeps protocol rejection as a hard failure without auth fallback", async () => {
		const router = createUploadFetchRouter({
			app: () => new Response('{"qKIAYe":"push-rejected"}', { status: 200 }),
			contentPush(init) {
				assert.equal(init.headers.Cookie, undefined);
				assert.equal(init.headers.Authorization, undefined);
				return new Response("unsupported media type", { status: 415 });
			},
		});
		await withFetch(router.fetch, async () => {
			const error = await captureError(() =>
				uploadTextFile(
					baseUploadConfig({
						cookie: "__Secure-1PSID=psid; SAPISID=sapi",
						sapisid: "sapi",
					}),
					"fallback text",
					"message.txt",
				),
			);
			assert.equal(error.code, "content_push_http_status");
			assert.equal(error.status, 415);
			assert.equal(error.protocol, "multipart");
		});
		assert.deepEqual(router.requests, [
			"https://gemini.example/app",
			"https://content-push.googleapis.com/upload",
			"https://gemini.example/app",
		]);
	});

	test("keeps invalid file refs as a hard failure", async () => {
		const router = createUploadFetchRouter({
			app: () => new Response('{"qKIAYe":"push-invalid-ref"}', { status: 200 }),
			contentPush: () =>
				new Response("not-a-content-push-ref", { status: 200 }),
		});
		await withFetch(router.fetch, async () => {
			const error = await captureError(() =>
				uploadTextFile(
					baseUploadConfig({ cookie: "__Secure-1PSID=psid" }),
					"hello",
					"message.txt",
				),
			);
			assert.equal(error.code, "content_push_invalid_ref");
			assert.equal(error.protocol, "multipart");
		});
		assert.deepEqual(router.requests, [
			"https://gemini.example/app",
			"https://content-push.googleapis.com/upload",
		]);
	});

	test("propagates network failures without attempting auth transport", async () => {
		const router = createUploadFetchRouter({
			app: () => new Response('{"qKIAYe":"push-network"}', { status: 200 }),
			contentPush(init) {
				assert.equal(init.headers.Cookie, undefined);
				assert.equal(init.headers.Authorization, undefined);
				throw new Error("content-push network failed");
			},
		});
		await withFetch(router.fetch, async () => {
			await assert.rejects(
				() =>
					uploadTextFile(
						baseUploadConfig({
							cookie: "__Secure-1PSID=psid; SAPISID=sapi",
							sapisid: "sapi",
						}),
						"hello",
						"message.txt",
					),
				/content-push network failed/,
			);
		});
		assert.deepEqual(router.requests, [
			"https://gemini.example/app",
			"https://content-push.googleapis.com/upload",
		]);
	});
});
