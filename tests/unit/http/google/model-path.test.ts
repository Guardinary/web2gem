import { describe, test } from "vitest";
import { createRuntimeConfig, getConfig } from "../../../../src/config";
import { handleGoogleGenerate } from "../../../../src/http/google/handlers";
import { parseGoogleGenerationPath } from "../../../../src/http/google/model-path";
import { assert } from "../../assertions.js";
import { strictProvider } from "../_support/provider.js";

describe("Google model path", () => {
	test("parses the final Google generation action without truncating model IDs", async () => {
		assert.deepEqual(
			parseGoogleGenerationPath("/v1beta/models/future:model:generateContent"),
			{ modelName: "future:model", stream: false },
		);
		assert.deepEqual(
			parseGoogleGenerationPath(
				"/v1/models/future%3Amodel:streamGenerateContent",
			),
			{ modelName: "future:model", stream: true },
		);
		assert.equal(
			parseGoogleGenerationPath("/v1beta/models/future/model:generateContent"),
			null,
		);
		assert.equal(
			parseGoogleGenerationPath(
				"/v1beta/models/future%2Fmodel:generateContent",
			),
			null,
		);
		assert.equal(
			parseGoogleGenerationPath("/v1beta/models/:generateContent"),
			null,
		);
		assert.equal(
			parseGoogleGenerationPath(
				"/v1beta/models/future%ZZmodel:generateContent",
			),
			null,
		);
		assert.equal(
			parseGoogleGenerationPath("/v1beta/models/future:model:countTokens"),
			null,
		);

		let resolvedName = "";
		const provider = strictProvider({
			async resolveModel(name) {
				const modelName = String(name);
				resolvedName = modelName;
				return {
					name: modelName,
					family: null,
					extended: false,
					dynamicProviderId: modelName,
				};
			},
			async generateText() {
				return "done";
			},
		});
		const route = parseGoogleGenerationPath(
			"/v1beta/models/future:model:generateContent",
		);
		if (!route) throw new Error("expected generation route");
		const response = await handleGoogleGenerate(
			{
				contents: [{ role: "user", parts: [{ text: "plain request" }] }],
			},
			createRuntimeConfig(getConfig()),
			provider,
			route,
		);
		assert.equal(response.status, 200);
		assert.equal(resolvedName, "future:model");
	});
});
