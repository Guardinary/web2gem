// @ts-nocheck
import { describe, test } from "vitest";
import worker from "../../../../src/index";
import { assert } from "../../assertions.js";

describe("admin WebUI HTTP contract", () => {
	test("serves the simplified admin UI without D1 reads or removed controls", async () => {
		let prepareCalls = 0;
		const env = {
			ADMIN_KEY: "admin-secret",
			GEMINI_DB: {
				prepare() {
					prepareCalls++;
					throw new Error("admin UI must not prepare D1 statements");
				},
			},
		};
		const response = await worker.fetch(
			new Request("https://worker.example/admin"),
			env,
			{},
		);
		assert.equal(response.status, 200);
		assert.equal(prepareCalls, 0);
		assert.equal(
			response.headers.get("content-type"),
			"text/html; charset=utf-8",
		);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.headers.get("referrer-policy"), "no-referrer");
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.equal(
			response.headers.get("content-security-policy"),
			"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' blob: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		);
		const html = await response.text();
		assert.match(html, /Gemini Account Pool/);
		assert.match(html, /Label or account ID/);
		assert.match(html, /All states/);
		assert.match(html, /Current issue/);
		assert.match(html, /primary-metrics/);
		assert.match(html, /Model route priority/);
		assert.match(html, /Reset to discovery order/);
		assert.doesNotMatch(
			html,
			/More filters|secondary-metrics|Export CSV|Diagnostics|Check selected|account_category|success_count/,
		);
		assert.doesNotMatch(
			html,
			/GEMINI_COOKIE|SAPISID=|SNlM0e=|Cookie:\s*__Secure/i,
		);
		assert.doesNotMatch(html, /admin-secret/);
	});

	test("rejects non-GET admin UI requests without D1 access", async () => {
		let prepareCalls = 0;
		const response = await worker.fetch(
			new Request("https://worker.example/admin", { method: "POST" }),
			{
				ADMIN_KEY: "admin-secret",
				GEMINI_DB: {
					prepare() {
						prepareCalls++;
						throw new Error("admin UI must not prepare D1 statements");
					},
				},
			},
			{},
		);

		assert.equal(response.status, 404);
		assert.equal(prepareCalls, 0);
		assert.equal(
			response.headers.get("content-type"),
			"text/plain; charset=utf-8",
		);
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.equal(await response.text(), "admin UI route not found");
	});
});
