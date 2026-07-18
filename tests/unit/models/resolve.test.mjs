import { describe, test } from "vitest";
import {
	dynamicProviderModelCandidates,
	resolveModel,
} from "../../../src/models";
import { assert } from "../assertions.js";

describe("model resolution", () => {
	test("resolves default models and rejects empty or unknown explicit models", () => {
		assert.equal(
			resolveModel(undefined, "gemini-3.5-flash").name,
			"gemini-3.5-flash",
		);
		assert.equal(
			resolveModel("", "gemini-3.5-flash").error,
			"model (empty) is not available",
		);
		assert.equal(
			resolveModel("not-a-model", "gemini-3.5-flash").error,
			"model not-a-model is not available",
		);
	});

	test("rejects removed thinking and enhanced model syntax", () => {
		assert.match(
			resolveModel("gemini-3.5-flash@think=fast", "gemini-3.5-flash").error,
			/not available/,
		);
		assert.match(
			resolveModel("gemini-3.1-pro-enhanced", "gemini-3.5-flash").error,
			/not available/,
		);
	});

	test("orders exact dynamic model IDs before extended suffix candidates", () => {
		assert.deepEqual(dynamicProviderModelCandidates("future-model-extended"), [
			{ providerModelId: "future-model-extended", extended: false },
			{ providerModelId: "future-model", extended: true },
		]);
	});
});
