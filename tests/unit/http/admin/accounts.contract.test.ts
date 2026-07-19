// @ts-nocheck
import { describe, test } from "vitest";
import { handleGeminiAccountAdminRequest } from "../../../../src/http/admin/gemini-accounts";
import { assert } from "../../assertions.js";
import { baseConfig } from "../../_support/runtime-config.js";

const cfg = { ...baseConfig(), admin_key: "admin-secret" };

function failOnD1() {
	return {
		prepare(sql) {
			throw new Error(`unexpected D1 access: ${sql}`);
		},
	};
}

function request(path, init = {}, env = {}) {
	const url = new URL(`https://worker.example${path}`);
	return handleGeminiAccountAdminRequest(
		new Request(url, {
			...init,
			headers: {
				Authorization: "Bearer admin-secret",
				...(init.headers || {}),
			},
		}),
		env,
		cfg,
		url,
	);
}

describe("Gemini account admin HTTP contract", () => {
	test("rejects an unauthorized request before D1 access", async () => {
		const url = new URL("https://worker.example/admin/accounts");
		const response = await handleGeminiAccountAdminRequest(
			new Request(url),
			{ GEMINI_DB: failOnD1() },
			cfg,
			url,
		);
		assert.equal(response.status, 401);
		assert.equal((await response.json()).error.code, "invalid_admin_key");
	});

	test("returns 404 for retired stats and account-check routes without D1 access", async () => {
		for (const path of ["/admin/accounts/stats", "/admin/accounts/a/check"]) {
			const response = await request(path, {}, { GEMINI_DB: failOnD1() });
			assert.equal(response.status, 404);
			assert.equal((await response.json()).error.code, "admin_route_not_found");
		}
	});

	test("returns a sanitized legacy-query error before D1 access", async () => {
		const response = await request(
			"/admin/accounts?status=active",
			{},
			{ GEMINI_DB: failOnD1() },
		);
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), {
			error: {
				code: "unknown_admin_query_parameter",
				message: "unknown admin query parameter: status",
			},
		});
	});

	test("recognizes list and create routes before reporting a missing store", async () => {
		const list = await request("/admin/accounts");
		assert.equal(list.status, 503);
		assert.equal(
			(await list.json()).error.code,
			"gemini_account_store_unavailable",
		);

		const create = await request("/admin/accounts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				"__Secure-1PSID": "p",
				"__Secure-1PSIDTS": "t",
			}),
		});
		assert.equal(create.status, 503);
		assert.equal(
			(await create.json()).error.code,
			"gemini_account_store_unavailable",
		);
	});

	test("recognizes bulk-action routing before reporting a missing store", async () => {
		const response = await request("/admin/accounts/actions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "enable", ids: ["a"] }),
		});
		assert.equal(response.status, 503);
		assert.equal(
			(await response.json()).error.code,
			"gemini_account_store_unavailable",
		);
	});

	test("recognizes update, delete, and refresh resource commands", async () => {
		for (const [path, init] of [
			[
				"/admin/accounts/a",
				{
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ label: "A" }),
				},
			],
			["/admin/accounts/a", { method: "DELETE" }],
			["/admin/accounts/a/refresh", { method: "POST" }],
		]) {
			const response = await request(path, init);
			assert.equal(response.status, 503);
			assert.equal(
				(await response.json()).error.code,
				"gemini_account_store_unavailable",
			);
		}
	});

	test("rejects malformed JSON before D1 access", async () => {
		const response = await request(
			"/admin/accounts",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			},
			{ GEMINI_DB: failOnD1() },
		);
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error.code, "invalid_admin_json");
	});

	test("rejects a delete body and an unknown resource action before D1 access", async () => {
		const deleteBody = await request(
			"/admin/accounts/a",
			{ method: "DELETE", body: "unexpected" },
			{ GEMINI_DB: failOnD1() },
		);
		assert.equal(deleteBody.status, 400);
		assert.equal(
			(await deleteBody.json()).error.code,
			"admin_request_body_not_allowed",
		);

		const unknown = await request(
			"/admin/accounts/a/unknown",
			{ method: "POST" },
			{ GEMINI_DB: failOnD1() },
		);
		assert.equal(unknown.status, 404);
		assert.equal((await unknown.json()).error.code, "admin_route_not_found");
	});
});
