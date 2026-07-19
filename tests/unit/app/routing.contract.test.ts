// @ts-nocheck
import { describe, test } from "vitest";
import { handleApplicationRequest } from "../../../src/app";
import worker from "../../../src/index";
import { assert } from "../assertions.js";

describe("application routing contract", () => {
	test("keeps application route policy ordering explicit", async () => {
		const execution = { waitUntil() {} };
		const routeCases = [
			{
				method: "OPTIONS",
				path: "/v1/models",
				env: { LOG_REQUESTS: "false" },
				status: 204,
			},
			{
				method: "GET",
				path: "/",
				env: { API_KEYS: "required" },
				status: 200,
			},
			{
				method: "GET",
				path: "/v1/models",
				env: { API_KEYS: "required" },
				status: 401,
			},
			{
				method: "GET",
				path: "/admin",
				env: { API_KEYS: "required" },
				status: 200,
			},
			{
				method: "GET",
				path: "/missing",
				env: {},
				status: 404,
			},
			{
				method: "POST",
				path: "/missing",
				env: {},
				status: 404,
			},
		];
		for (const item of routeCases) {
			const response = await handleApplicationRequest(
				new Request(`https://worker.example${item.path}`, {
					method: item.method,
				}),
				item.env,
				execution,
			);
			assert.equal(response.status, item.status, `${item.method} ${item.path}`);
		}
	});
	test("keeps the Worker entrypoint aligned with the application core", async () => {
		const request = () => new Request("https://worker.example/v1/models");
		const execution = { waitUntil() {} };
		const direct = await handleApplicationRequest(request(), {}, execution);
		const workerResponse = await worker.fetch(request(), {}, execution);
		assert.equal(workerResponse.status, direct.status);
		assert.equal(
			workerResponse.headers.get("content-type"),
			direct.headers.get("content-type"),
		);
		assert.equal(await workerResponse.text(), await direct.text());
	});
	test("handles CORS preflight requested headers and private network opt-in", async () => {
		const defaultResp = await worker.fetch(
			new Request("https://worker.example/"),
			{},
			{},
		);
		const defaultAllowHeaders =
			defaultResp.headers.get("Access-Control-Allow-Headers") || "";
		assert.match(defaultAllowHeaders, /Content-Type/);
		assert.match(defaultAllowHeaders, /X-API-Key/);
		const resp = await worker.fetch(
			new Request("https://worker.example/v1/chat/completions", {
				method: "OPTIONS",
				headers: {
					Origin: "https://app.example",
					"Access-Control-Request-Headers":
						"X-Custom, x-ds2-internal-token, Bad Header, X-Custom",
					"Access-Control-Request-Private-Network": "true",
				},
			}),
			{},
			{},
		);
		assert.equal(resp.status, 204);
		assert.equal(
			resp.headers.get("Access-Control-Allow-Origin"),
			"https://app.example",
		);
		assert.equal(
			resp.headers.get("Access-Control-Allow-Private-Network"),
			"true",
		);
		const allowHeaders = resp.headers.get("Access-Control-Allow-Headers") || "";
		assert.match(allowHeaders, /X-Custom/);
		assert.doesNotMatch(allowHeaders, /x-ds2-internal-token/i);
		assert.doesNotMatch(allowHeaders, /Bad Header/);
		assert.equal((allowHeaders.match(/X-Custom/g) || []).length, 1);
	});
	test("accepts alternate API key locations and rejects missing keys", async () => {
		const env = { API_KEYS: '["sk-test", "sk-secondary"]' };
		const missing = await worker.fetch(
			new Request("https://worker.example/v1/models"),
			env,
			{},
		);
		assert.equal(missing.status, 401);
		const bearer = await worker.fetch(
			new Request("https://worker.example/v1/models", {
				headers: { Authorization: "  Bearer sk-test  " },
			}),
			env,
			{},
		);
		assert.equal(bearer.status, 200);
		const apiKey = await worker.fetch(
			new Request("https://worker.example/v1/models", {
				headers: { "X-API-Key": "sk-test" },
			}),
			env,
			{},
		);
		assert.equal(apiKey.status, 200);
		const googleKey = await worker.fetch(
			new Request("https://worker.example/v1beta/models", {
				headers: { "X-Goog-Api-Key": "sk-test" },
			}),
			env,
			{},
		);
		assert.equal(googleKey.status, 200);
		const queryKey = await worker.fetch(
			new Request("https://worker.example/v1/models?key=sk-test"),
			env,
			{},
		);
		assert.equal(queryKey.status, 200);
		const paddedQueryKey = await worker.fetch(
			new Request("https://worker.example/v1/models?key=%20sk-test%20"),
			env,
			{},
		);
		assert.equal(paddedQueryKey.status, 200);
		const nearMissQueryKey = await worker.fetch(
			new Request("https://worker.example/v1/models?key=%20sk-test-extra%20"),
			env,
			{},
		);
		assert.equal(nearMissQueryKey.status, 401);
	});
});
