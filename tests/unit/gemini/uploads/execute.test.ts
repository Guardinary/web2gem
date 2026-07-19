// @ts-nocheck
import { afterEach, beforeEach, describe, test } from "vitest";
import { uploadTextFile } from "../../../../src/gemini/uploads/execute";
import { assert } from "../../assertions.js";
import { withFetch } from "../../_support/globals.js";
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

describe("required Gemini uploads", () => {
	beforeEach(resetUploadState);
	afterEach(resetUploadState);

	test("uploads required text through unauthenticated multipart transport", async () => {
		const requests = [];
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				requests.push(href);
				if (href === "https://gemini.example/app") {
					return new Response('{"qKIAYe":"push-text"}', { status: 200 });
				}
				if (href === "https://content-push.googleapis.com/upload") {
					await assertMultipartRequest(init, {
						filename: "message.txt",
						mime: "text/plain; charset=utf-8",
						bodyText: "hello",
						pushId: "push-text",
					});
					return new Response("/uploaded/text-ref", { status: 200 });
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
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
			},
		);
		assert.deepEqual(requests, [
			"https://gemini.example/app",
			"https://content-push.googleapis.com/upload",
		]);
	});

	test("keeps protocol rejection as a hard failure without auth fallback", async () => {
		const requests = [];
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				requests.push(href);
				if (href === "https://gemini.example/app") {
					return new Response('{"qKIAYe":"push-rejected"}', { status: 200 });
				}
				if (href === "https://content-push.googleapis.com/upload") {
					assert.equal(init.headers.Cookie, undefined);
					assert.equal(init.headers.Authorization, undefined);
					return new Response("unsupported media type", { status: 415 });
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
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
			},
		);
		assert.deepEqual(requests, [
			"https://gemini.example/app",
			"https://content-push.googleapis.com/upload",
			"https://gemini.example/app",
		]);
	});

	test("keeps invalid file refs as a hard failure", async () => {
		const requests = [];
		await withFetch(
			async (url) => {
				const href = String(url);
				requests.push(href);
				if (href === "https://gemini.example/app") {
					return new Response('{"qKIAYe":"push-invalid-ref"}', { status: 200 });
				}
				if (href === "https://content-push.googleapis.com/upload") {
					return new Response("not-a-content-push-ref", { status: 200 });
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				const error = await captureError(() =>
					uploadTextFile(
						baseUploadConfig({ cookie: "__Secure-1PSID=psid" }),
						"hello",
						"message.txt",
					),
				);
				assert.equal(error.code, "content_push_invalid_ref");
				assert.equal(error.protocol, "multipart");
			},
		);
		assert.deepEqual(requests, [
			"https://gemini.example/app",
			"https://content-push.googleapis.com/upload",
		]);
	});

	test("propagates network failures without attempting auth transport", async () => {
		const requests = [];
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				requests.push(href);
				if (href === "https://gemini.example/app") {
					return new Response('{"qKIAYe":"push-network"}', { status: 200 });
				}
				if (href === "https://content-push.googleapis.com/upload") {
					assert.equal(init.headers.Cookie, undefined);
					assert.equal(init.headers.Authorization, undefined);
					throw new Error("content-push network failed");
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
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
			},
		);
		assert.deepEqual(requests, [
			"https://gemini.example/app",
			"https://content-push.googleapis.com/upload",
		]);
	});
});
