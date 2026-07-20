import { describe, test } from "vitest";
import type { ApplicationExecutionContext } from "../../../src/app";
import worker from "../../../src/index";
import { isRecord } from "../../../src/shared/types";
import { assert } from "../assertions.js";

const executionContext: ApplicationExecutionContext = { waitUntil() {} };

describe("application runtime-config error contract", () => {
	test("returns sanitized Worker errors for invalid runtime config", async () => {
		const secret = "runtime-config-secret";
		const response = await worker.fetch(
			new Request("https://worker.example/v1/models"),
			{ GEMINI_ORIGIN: `https://user:${secret}@example.test/path` },
			executionContext,
		);
		assert.equal(response.status, 500);
		const body = await response.json();
		if (!isRecord(body) || !isRecord(body.error))
			throw new Error("expected error body");
		assert.equal(body.error.code, "invalid_runtime_config");
		assert.equal(body.error.setting, "GEMINI_ORIGIN");
		assert.match(body.error.reason, /absolute HTTP\(S\) origin/);
		assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
	});
});
