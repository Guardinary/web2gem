import { describe, test } from "vitest";
import type { ApplicationExecutionContext } from "../../../src/app";
import worker from "../../../src/index";
import { withFetch } from "../_support/globals.js";
import { assert } from "../assertions.js";
import { errorBody } from "./_support/fixtures.js";

const executionContext: ApplicationExecutionContext = { waitUntil() {} };

async function withNoUpstream<T>(run: () => T | PromiseLike<T>): Promise<T> {
	let upstreamCalls = 0;
	const result = await withFetch(async () => {
		upstreamCalls += 1;
		throw new Error("invalid request must not call upstream fetch");
	}, run);
	assert.equal(upstreamCalls, 0);
	return result;
}

function streamingRequest(url: string, init: RequestInit): Request {
	const streamingInit: RequestInit & { duplex: "half" } = {
		...init,
		duplex: "half",
	};
	return new Request(url, streamingInit);
}

describe("application body-limit contract", () => {
	test("rejects configured JSON body limits before account or provider work", async () => {
		const paths = [
			"/v1/chat/completions",
			"/v1beta/models/gemini-3.5-flash:generateContent",
		];
		for (const path of paths) {
			let d1Reads = 0;
			const resp = await withNoUpstream(() =>
				worker.fetch(
					new Request(`https://worker.example${path}`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Content-Length": "11",
						},
						body: "12345678901",
					}),
					{
						API_KEYS: "",
						REQUEST_BODY_MAX_BYTES: "10",
						GEMINI_DB: {
							prepare() {
								d1Reads += 1;
								throw new Error("oversized JSON should not read D1");
							},
						},
					},
					executionContext,
				),
			);
			assert.equal(resp.status, 413);
			const body = errorBody(await resp.json());
			assert.equal(body.code, "request_body_too_large");
			assert.equal(d1Reads, 0);
		}
	});
	test("rejects oversized chat body by Content-Length before JSON parsing", async () => {
		const bodyText = "x".repeat(40);
		const resp = await withNoUpstream(() =>
			worker.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": String(bodyText.length),
					},
					body: bodyText,
				}),
				{
					API_KEYS: "",
					CURRENT_INPUT_FILE_ENABLED: "true",
					CURRENT_INPUT_FILE_MIN_BYTES: "10",
					GENERIC_FILE_UPLOAD_MAX_BYTES: "0",
					LOG_REQUESTS: "false",
				},
				executionContext,
			),
		);
		assert.equal(resp.status, 422);
		const body = errorBody(await resp.json());
		assert.equal(body.code, "gemini_authenticated_session_required");
		assert.equal(body.reason, "large_context");
		assert.match(body.message, /40 bytes > inline read limit 10/);
	});
	test("rejects oversized streamed chat body before JSON parsing", async () => {
		const encoder = new TextEncoder();
		const bodyStream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode('{"messages":['));
				controller.enqueue(
					encoder.encode("not valid json but already too large"),
				);
				controller.close();
			},
		});
		const resp = await withNoUpstream(() =>
			worker.fetch(
				streamingRequest("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: bodyStream,
				}),
				{
					API_KEYS: "",
					CURRENT_INPUT_FILE_ENABLED: "true",
					CURRENT_INPUT_FILE_MIN_BYTES: "10",
					GENERIC_FILE_UPLOAD_MAX_BYTES: "0",
					LOG_REQUESTS: "false",
				},
				executionContext,
			),
		);
		assert.equal(resp.status, 422);
		const body = errorBody(await resp.json());
		assert.equal(body.code, "gemini_authenticated_session_required");
		assert.match(body.message, /exceeds inline read limit 10/);
	});
});
