import { describe, test } from "vitest";
import { readRouteJsonPost } from "../../../src/http/route-body";
import { assert } from "../assertions.js";

function streamingRequest(url: string, init: RequestInit): Request {
	const streamingInit: RequestInit & { duplex: "half" } = {
		...init,
		duplex: "half",
	};
	return new Request(url, streamingInit);
}

describe("route JSON body policy", () => {
	test("cancels streamed JSON bodies at the configured application limit", async () => {
		let canceled = false;
		const result = await readRouteJsonPost(
			streamingRequest("https://worker.example/v1/responses", {
				method: "POST",
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"x":"12345"'));
					},
					cancel() {
						canceled = true;
					},
				}),
			}),
			{
				current_input_file_enabled: true,
				request_body_max_bytes: 10,
				supports_authenticated_session: true,
			},
			"/v1/responses",
		);
		assert.equal(result.status, 413);
		assert.equal(result.code, "request_body_too_large");
		assert.equal(canceled, true);
	});
	test("parses image request bodies that exceed the inline prompt threshold", async () => {
		const body = JSON.stringify({
			model: "gemini-3.5-flash",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe this" },
						{
							type: "image_url",
							image_url: { url: `data:image/png;base64,${"A".repeat(80)}` },
						},
					],
				},
			],
		});
		assert.equal(body.length > 40, true);
		const result = await readRouteJsonPost(
			new Request("https://worker.example/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(body.length),
				},
				body,
			}),
			{
				current_input_file_enabled: true,
				current_input_file_min_bytes: 40,
				generic_file_upload_max_bytes: 1024,
			},
			"/v1/chat/completions",
		);
		assert.equal(result.error, undefined);
		if (result.error !== undefined || !result.value)
			throw new Error("expected parsed body");
		const messages = result.value.messages;
		if (!Array.isArray(messages)) throw new Error("expected messages");
		const first = messages[0];
		if (!first || typeof first !== "object" || !("content" in first))
			throw new Error("expected message content");
		const content = first.content;
		if (!Array.isArray(content)) throw new Error("expected content parts");
		const part = content[0];
		if (!part || typeof part !== "object" || !("text" in part))
			throw new Error("expected text part");
		assert.equal(part.text, "describe this");
	});
});
