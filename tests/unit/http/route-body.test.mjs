import { describe, test } from "vitest";
import { readRouteJsonPost } from "../../../src/http/route-body";
import { assert } from "../assertions.js";

describe("route JSON body policy", () => {
	test("cancels streamed JSON bodies at the configured application limit", async () => {
		let canceled = false;
		const result = await readRouteJsonPost(
			new Request("https://worker.example/v1/responses", {
				method: "POST",
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"x":"12345"'));
					},
					cancel() {
						canceled = true;
					},
				}),
				duplex: "half",
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
				cookie: "",
				log_requests: false,
			},
			"/v1/chat/completions",
		);
		assert.equal(result.error, undefined);
		assert.equal(result.value.messages[0].content[0].text, "describe this");
	});
});
