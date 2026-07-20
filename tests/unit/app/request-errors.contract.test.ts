import { describe, test } from "vitest";
import type { ApplicationExecutionContext } from "../../../src/app";
import worker from "../../../src/index";
import { isRecord, type UnknownRecord } from "../../../src/shared/types";
import { withConsoleLog, withFetch } from "../_support/globals.js";
import { assert } from "../assertions.js";

const executionContext: ApplicationExecutionContext = { waitUntil() {} };

function record(value: unknown, label: string): UnknownRecord {
	if (!isRecord(value)) throw new Error(`expected ${label}`);
	return value;
}

function errorBody(value: unknown): UnknownRecord {
	return record(record(value, "response body").error, "error body");
}

async function withNoUpstream<T>(run: () => T | PromiseLike<T>): Promise<T> {
	let upstreamCalls = 0;
	const result = await withFetch(async () => {
		upstreamCalls += 1;
		throw new Error("request rejection must not call upstream fetch");
	}, run);
	assert.equal(upstreamCalls, 0);
	return result;
}

describe.sequential("application request error contract", () => {
	test("maps malformed route JSON to OpenAI and Google error envelopes", async () => {
		const openai = await worker.fetch(
			new Request("https://worker.example/v1/chat/completions", {
				method: "POST",
				body: "[]",
			}),
			{},
			executionContext,
		);
		assert.equal(openai.status, 400);
		const openaiBody = errorBody(await openai.json());
		assert.equal(openaiBody.message, "request body must be a JSON object");
		assert.equal(openaiBody.type, "invalid_request_error");

		const google = await worker.fetch(
			new Request(
				"https://worker.example/v1beta/models/gemini-3.5-flash:generateContent",
				{
					method: "POST",
					body: "{",
				},
			),
			{},
			executionContext,
		);
		assert.equal(google.status, 400);
		const googleBody = errorBody(await google.json());
		assert.equal(googleBody.message, "invalid JSON");

		const googleV1 = await worker.fetch(
			new Request(
				"https://worker.example/v1/models/gemini-3.5-flash:generateContent",
				{
					method: "POST",
					body: "[]",
				},
			),
			{},
			executionContext,
		);
		assert.equal(googleV1.status, 400);
		const googleV1Body = errorBody(await googleV1.json());
		assert.equal(googleV1Body.message, "request body must be a JSON object");
	});
	test("does not read D1 accounts before public auth or JSON validation succeeds", async () => {
		let prepareCalls = 0;
		const env = {
			API_KEYS: "sk-test",
			GEMINI_DB: {
				prepare() {
					prepareCalls += 1;
					throw new Error("D1 should not be read before auth and validation");
				},
			},
		};

		const unauthorized = await worker.fetch(
			new Request("https://worker.example/v1/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
			env,
			executionContext,
		);
		assert.equal(unauthorized.status, 401);
		assert.equal(prepareCalls, 0);

		const invalidJson = await worker.fetch(
			new Request("https://worker.example/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer sk-test",
				},
				body: "[]",
			}),
			env,
			executionContext,
		);
		assert.equal(invalidJson.status, 400);
		assert.equal(
			errorBody(await invalidJson.json()).message,
			"request body must be a JSON object",
		);
		assert.equal(prepareCalls, 0);
	});
	test("maps malformed Google streaming JSON to its error envelope", async () => {
		const response = await worker.fetch(
			new Request(
				"https://worker.example/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
				{
					method: "POST",
					body: "[]",
				},
			),
			{},
			executionContext,
		);
		assert.equal(response.status, 400);
		const body = errorBody(await response.json());
		assert.equal(body.message, "request body must be a JSON object");
	});
	test("returns not found for unsupported model methods", async () => {
		const response = await worker.fetch(
			new Request("https://worker.example/v1/models", {
				method: "PATCH",
			}),
			{},
			executionContext,
		);
		assert.equal(response.status, 404);
		assert.deepEqual(await response.json(), { error: "not found" });
	});
	test("returns not found for unknown POST routes", async () => {
		const response = await worker.fetch(
			new Request("https://worker.example/v1/unknown", {
				method: "POST",
				body: "{}",
			}),
			{},
			executionContext,
		);
		assert.equal(response.status, 404);
		assert.deepEqual(await response.json(), { error: "not found" });
	});
	test("returns not found for malformed model detail paths", async () => {
		const logs: string[] = [];
		const response = await withConsoleLog(
			(line: unknown) => {
				logs.push(String(line));
			},
			() =>
				worker.fetch(
					new Request("https://worker.example/v1/models/%E0%A4%A", {
						headers: { Origin: "https://app.example" },
					}),
					{ LOG_REQUESTS: "true" },
					executionContext,
				),
		);
		assert.equal(response.status, 404);
		assert.equal(
			response.headers.get("Access-Control-Allow-Origin"),
			"https://app.example",
		);
		assert.deepEqual(await response.json(), { error: "not found" });
		assert.equal(logs.length, 1);
		assert.match(
			logs[0],
			/^\[web2gem\] stage=request_complete requestId=.+ method=GET path=\/v1\/models\/%E0%A4%A status=404 ms=/,
		);
	});
	test("rejects empty chat prompts before context-file handling", async () => {
		const emptyChat = await withNoUpstream(() =>
			worker.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: "gemini-3.5-flash",
						messages: [],
					}),
				}),
				{},
				executionContext,
			),
		);
		assert.equal(emptyChat.status, 400);
		assert.equal(errorBody(await emptyChat.json()).message, "empty prompt");

		const contextAvailableBody = JSON.stringify({
			model: "gemini-3.5-flash",
			messages: [],
		});
		const contextAvailable = await withNoUpstream(() =>
			worker.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": String(contextAvailableBody.length),
					},
					body: contextAvailableBody,
				}),
				{
					CURRENT_INPUT_FILE_ENABLED: "true",
					CURRENT_INPUT_FILE_MIN_BYTES: "1",
				},
				executionContext,
			),
		);
		assert.equal(contextAvailable.status, 400);
		assert.equal(
			errorBody(await contextAvailable.json()).message,
			"empty prompt",
		);
	});
});
