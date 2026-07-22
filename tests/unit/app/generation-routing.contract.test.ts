import { describe, test } from "vitest";
import type { ApplicationExecutionContext } from "../../../src/app";
import worker from "../../../src/index";
import { isRecord, type UnknownRecord } from "../../../src/shared/types";
import { withFetch } from "../_support/globals.js";
import { assert } from "../assertions.js";
import { errorBody, record } from "./_support/fixtures.js";

const executionContext: ApplicationExecutionContext = { waitUntil() {} };

function firstRecord(value: unknown, label: string): UnknownRecord {
	if (!Array.isArray(value) || !isRecord(value[0]))
		throw new Error(`expected ${label}`);
	return value[0];
}

function geminiTextResponse(text: string): Response {
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
				executionContext,
			);
		const resp = await withFetch(async () => {
			fetchCalls += 1;
			return geminiTextResponse("anonymous answer");
		}, run);
		assert.equal(resp.status, 200);
		const body = await resp.json();
		const choice = firstRecord(
			record(body, "response body").choices,
			"choices",
		);
		assert.equal(record(choice.message, "message").content, "anonymous answer");
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
					executionContext,
				),
		);
		assert.equal(google.status, 200);
		const googleBody = record(await google.json(), "response body");
		const candidate = firstRecord(googleBody.candidates, "candidates");
		const content = record(candidate.content, "content");
		const part = firstRecord(content.parts, "parts");
		assert.equal(part.text, "google anonymous");
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
					executionContext,
				),
		);
		assert.equal(pro.status, 422);
		const proBody = errorBody(await pro.json());
		assert.equal(proBody.code, "gemini_authenticated_session_required");
		assert.equal(proBody.reason, "pro_model");
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
			executionContext,
		);
		assert.equal(resp.status, 422);
		const body = errorBody(await resp.json());
		assert.equal(body.code, "gemini_authenticated_session_required");
		assert.equal(body.reason, "large_context");

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
			executionContext,
		);
		assert.equal(google.status, 422);
		const googleBody = errorBody(await google.json());
		assert.equal(googleBody.code, "gemini_authenticated_session_required");
		assert.equal(googleBody.reason, "large_context");

		const image = await worker.fetch(
			new Request("https://worker.example/v1/images/generations", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "draw a square" }),
			}),
			{},
			executionContext,
		);
		assert.equal(image.status, 422);
		const imageBody = errorBody(await image.json());
		assert.equal(imageBody.code, "gemini_authenticated_session_required");
		assert.equal(imageBody.reason, "image");

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
			executionContext,
		);
		assert.equal(attachment.status, 422);
		const attachmentBody = errorBody(await attachment.json());
		assert.equal(attachmentBody.code, "gemini_authenticated_session_required");
		assert.equal(attachmentBody.reason, "attachment");
	});
});
