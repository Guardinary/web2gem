// @ts-nocheck
import { describe, test } from "vitest";
import worker from "../../../src/index";
import { assert } from "../assertions.js";
import { withFetch } from "../_support/globals.js";

function geminiTextResponse(text) {
	const inner = [null, null, null, null, [[null, [text]]], "x".repeat(160)];
	return new Response(
		JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]),
		{ status: 200 },
	);
}

describe.sequential("application generation routing contract", () => {
	test("uses anonymous upstream for eligible public generation without D1", async () => {
		let fetchCalls = 0;
		const run = () =>
			worker.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: "gemini-3.5-flash",
						messages: [{ role: "user", content: "hello" }],
					}),
				}),
				{
					API_KEYS: "",
					LOG_REQUESTS: "false",
				},
				{},
			);
		const resp = await withFetch(async () => {
			fetchCalls += 1;
			return geminiTextResponse("anonymous answer");
		}, run);
		assert.equal(resp.status, 200);
		const body = await resp.json();
		assert.equal(body.choices[0].message.content, "anonymous answer");
		assert.equal(fetchCalls, 1);
	});
	test("shares anonymous routing with Google and keeps Pro account-required", async () => {
		let fetchCalls = 0;
		const google = await withFetch(
			async () => {
				fetchCalls += 1;
				return geminiTextResponse("google anonymous");
			},
			() =>
				worker.fetch(
					new Request(
						"https://worker.example/v1beta/models/gemini-3.5-flash:generateContent",
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								contents: [{ parts: [{ text: "hello" }] }],
							}),
						},
					),
					{},
					{},
				),
		);
		assert.equal(google.status, 200);
		assert.equal(
			(await google.json()).candidates[0].content.parts[0].text,
			"google anonymous",
		);
		assert.equal(fetchCalls, 1);

		const pro = await withFetch(
			async () => {
				fetchCalls += 1;
				throw new Error("Pro must not call anonymous upstream");
			},
			() =>
				worker.fetch(
					new Request("https://worker.example/v1/chat/completions", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							model: "gemini-3.1-pro",
							messages: [{ role: "user", content: "hello" }],
						}),
					}),
					{},
					{},
				),
		);
		assert.equal(pro.status, 422);
		const proBody = await pro.json();
		assert.equal(proBody.error.code, "gemini_authenticated_session_required");
		assert.equal(proBody.error.reason, "pro_model");
		assert.equal(fetchCalls, 1);
	});
	test("returns authenticated-session errors for oversized context without D1", async () => {
		const resp = await worker.fetch(
			new Request("https://worker.example/v1/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "x".repeat(40) }],
				}),
			}),
			{
				CURRENT_INPUT_FILE_ENABLED: "true",
				CURRENT_INPUT_FILE_MIN_BYTES: "10",
			},
			{},
		);
		assert.equal(resp.status, 422);
		const body = await resp.json();
		assert.equal(body.error.code, "gemini_authenticated_session_required");
		assert.equal(body.error.reason, "large_context");

		const google = await worker.fetch(
			new Request(
				"https://worker.example/v1beta/models/gemini-3.5-flash:generateContent",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						contents: [{ parts: [{ text: "x".repeat(40) }] }],
					}),
				},
			),
			{
				CURRENT_INPUT_FILE_ENABLED: "true",
				CURRENT_INPUT_FILE_MIN_BYTES: "10",
			},
			{},
		);
		assert.equal(google.status, 422);
		const googleBody = await google.json();
		assert.equal(
			googleBody.error.code,
			"gemini_authenticated_session_required",
		);
		assert.equal(googleBody.error.reason, "large_context");

		const image = await worker.fetch(
			new Request("https://worker.example/v1/images/generations", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "draw a square" }),
			}),
			{},
			{},
		);
		assert.equal(image.status, 422);
		const imageBody = await image.json();
		assert.equal(imageBody.error.code, "gemini_authenticated_session_required");
		assert.equal(imageBody.error.reason, "image");

		const attachment = await worker.fetch(
			new Request("https://worker.example/v1/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gemini-3.5-flash",
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "describe this image" },
								{
									type: "image_url",
									image_url: {
										url: "data:image/png;base64,iVBORw0KGgo=",
									},
								},
							],
						},
					],
				}),
			}),
			{},
			{},
		);
		assert.equal(attachment.status, 422);
		const attachmentBody = await attachment.json();
		assert.equal(
			attachmentBody.error.code,
			"gemini_authenticated_session_required",
		);
		assert.equal(attachmentBody.error.reason, "attachment");
	});
});
