import { strictProvider } from "../_support/provider.js";
import { describe, test } from "vitest";
import { handleGoogleGenerate } from "../../../../src/http/google/handlers";
import { parseGoogleGenerationPath } from "../../../../src/http/google/model-path";
import { assert } from "../../assertions.js";

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
				resolvedName = name;
				return {
					name,
					family: null,
					extended: false,
					dynamicProviderId: name,
				};
			},
			async generateText() {
				return "done";
			},
		});
		const response = await handleGoogleGenerate(
			{
				contents: [{ role: "user", parts: [{ text: "plain request" }] }],
			},
			{
				default_model: "gemini-3.5-flash",
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "",
				log_requests: false,
			},
			provider,
			parseGoogleGenerationPath("/v1beta/models/future:model:generateContent"),
		);
		assert.equal(response.status, 200);
		assert.equal(resolvedName, "future:model");
	});
});
