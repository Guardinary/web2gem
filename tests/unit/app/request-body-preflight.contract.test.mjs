import { describe, test } from "vitest";
import worker from "../../../src/index";
import { assert } from "../assertions.js";
import { withFetch } from "../helpers.js";

async function withNoUpstream(run) {
	let upstreamCalls = 0;
	const result = await withFetch(async () => {
		upstreamCalls += 1;
		throw new Error("preflight rejection must not call upstream fetch");
	}, run);
	assert.equal(upstreamCalls, 0);
	return result;
}

describe("application request-body preflight contract", () => {
	test("rejects oversized inline OpenAI bodies from content length before parsing", async () => {
		const resp = await withNoUpstream(() =>
			worker.fetch(
				new Request("https://worker.example/v1/responses", {
					method: "POST",
					headers: {
						"Content-Length": "2",
					},
					body: "{}",
				}),
				{
					CURRENT_INPUT_FILE_ENABLED: "false",
					CURRENT_INPUT_FILE_MIN_BYTES: "1",
					GENERIC_FILE_UPLOAD_MAX_BYTES: "0",
				},
				{},
			),
		);
		assert.equal(resp.status, 422);
		const body = await resp.json();
		assert.equal(body.error.code, "gemini_authenticated_session_required");
		assert.equal(body.error.reason, "large_context");
		assert.match(body.error.message, /authenticated Gemini session/);
	});
});
