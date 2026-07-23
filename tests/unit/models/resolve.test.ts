import { describe, test } from "vitest";
import {
	buildGeminiModelCatalog,
	resolveModel,
	resolveModelFromCatalog,
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
		const catalog = buildGeminiModelCatalog(
			[
				{
					providerModelId: "future-model-extended",
					family: null,
					displayName: "Future Exact",
					description: "exact id first",
					available: true,
				},
				{
					providerModelId: "future-model",
					family: null,
					displayName: "Future Base",
					description: "extended base second",
					available: true,
				},
			],
			0,
		);
		const exact = resolveModelFromCatalog(
			"future-model-extended",
			"gemini-3.5-flash",
			catalog,
		);
		assert.equal(exact.error, undefined);
		assert.equal(exact.name, "future-model-extended");
		assert.equal(exact.dynamicProviderId, "future-model-extended");
		assert.equal(exact.extended, false);
		assert.equal(exact.family, null);

		const baseOnly = buildGeminiModelCatalog(
			[
				{
					providerModelId: "future-model",
					family: null,
					displayName: "Future Base",
					description: "extended base only",
					available: true,
				},
			],
			0,
		);
		const extended = resolveModelFromCatalog(
			"future-model-extended",
			"gemini-3.5-flash",
			baseOnly,
		);
		assert.equal(extended.error, undefined);
		assert.equal(extended.name, "future-model-extended");
		assert.equal(extended.dynamicProviderId, "future-model");
		assert.equal(extended.extended, true);
		assert.equal(extended.family, null);
	});
});
