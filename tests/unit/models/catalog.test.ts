// @ts-nocheck
import { describe, test } from "vitest";
import { MODELS, resolveModel } from "../../../src/models";
import { assert } from "../assertions.js";

describe("public model catalog", () => {
	test("exposes the six public models and extended metadata", () => {
		const extended = resolveModel(
			"gemini-3.1-pro-extended",
			"gemini-3.5-flash",
		);
		assert.equal(extended.name, "gemini-3.1-pro-extended");
		assert.equal(extended.family, "pro");
		assert.equal(extended.extended, true);
		assert.equal(extended.dynamicProviderId, null);
		assert.deepEqual(Object.keys(MODELS), [
			"gemini-3.1-pro",
			"gemini-3.1-pro-extended",
			"gemini-3.5-flash",
			"gemini-3.5-flash-extended",
			"gemini-3.1-flash-lite",
			"gemini-3.1-flash-lite-extended",
		]);
	});
});
