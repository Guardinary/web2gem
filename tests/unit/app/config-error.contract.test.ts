// @ts-nocheck
import { describe, test } from "vitest";
import worker from "../../../src/index";
import { assert } from "../assertions.js";

describe("application runtime-config error contract", () => {
	test("returns sanitized Worker errors for invalid runtime config", async () => {
		const secret = "runtime-config-secret";
		const response = await worker.fetch(
			new Request("https://worker.example/v1/models"),
			{ GEMINI_ORIGIN: `https://user:${secret}@example.test/path` },
			{},
		);
		assert.equal(response.status, 500);
		const body = await response.json();
		assert.equal(body.error.code, "invalid_runtime_config");
		assert.equal(body.error.setting, "GEMINI_ORIGIN");
		assert.match(body.error.reason, /absolute HTTP\(S\) origin/);
		assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
	});
});
