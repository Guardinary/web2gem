import { describe, test } from "vitest";
import worker from "../../../src/index";
import { assert } from "../assertions.js";
import { withConsoleLog, withFetch } from "../_support/globals.js";

async function withNoUpstream(run) {
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
			{},
		);
		assert.equal(openai.status, 400);
		const openaiBody = await openai.json();
		assert.equal(
			openaiBody.error.message,
			"request body must be a JSON object",
		);
		assert.equal(openaiBody.error.type, "invalid_request_error");

		const google = await worker.fetch(
			new Request(
				"https://worker.example/v1beta/models/gemini-3.5-flash:generateContent",
				{
					method: "POST",
					body: "{",
				},
			),
			{},
			{},
		);
		assert.equal(google.status, 400);
		const googleBody = await google.json();
		assert.equal(googleBody.error.message, "invalid JSON");

		const googleV1 = await worker.fetch(
			new Request(
				"https://worker.example/v1/models/gemini-3.5-flash:generateContent",
				{
					method: "POST",
					body: "[]",
				},
			),
			{},
			{},
		);
		assert.equal(googleV1.status, 400);
		const googleV1Body = await googleV1.json();
		assert.equal(
			googleV1Body.error.message,
			"request body must be a JSON object",
		);
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
			{},
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
			{},
		);
		assert.equal(invalidJson.status, 400);
		assert.equal(
			(await invalidJson.json()).error.message,
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
			{},
		);
		assert.equal(response.status, 400);
		const body = await response.json();
		assert.equal(body.error.message, "request body must be a JSON object");
	});
	test("returns not found for unsupported model methods", async () => {
		const response = await worker.fetch(
			new Request("https://worker.example/v1/models", {
				method: "PATCH",
			}),
			{},
			{},
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
			{},
		);
		assert.equal(response.status, 404);
		assert.deepEqual(await response.json(), { error: "not found" });
	});
	test("sanitizes unexpected route errors while preserving CORS and completion logs", async () => {
		const logs = [];
		const response = await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				worker.fetch(
					new Request("https://worker.example/v1/models/%E0%A4%A", {
						headers: { Origin: "https://app.example" },
					}),
					{ LOG_REQUESTS: "true" },
					{},
				),
		);
		assert.equal(response.status, 500);
		assert.equal(
			response.headers.get("Access-Control-Allow-Origin"),
			"https://app.example",
		);
		const body = await response.json();
		assert.deepEqual(body.error, {
			message: "internal server error",
			code: "internal_server_error",
		});
		assert.equal(logs.length, 2);
		assert.match(logs[0], /^\[web2gem\] error: type=URIError$/);
		assert.doesNotMatch(logs[0], /URI malformed|at /);
		assert.match(
			logs[1],
			/^\[web2gem\] stage=request_complete requestId=.+ method=GET path=\/v1\/models\/%E0%A4%A status=500 ms=/,
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
				{},
			),
		);
		assert.equal(emptyChat.status, 400);
		assert.equal((await emptyChat.json()).error.message, "empty prompt");

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
				{},
			),
		);
		assert.equal(contextAvailable.status, 400);
		assert.equal((await contextAvailable.json()).error.message, "empty prompt");
	});
});
