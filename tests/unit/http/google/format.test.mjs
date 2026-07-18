import { describe, test } from "vitest";
import {
	googleGenerateContentResponse,
	googleStreamDonePayload,
} from "../../../../src/http/google/format";
import { assert } from "../../assertions.js";

describe("Google response format", () => {
	test("formats Google response helper payloads", () => {
		const response = googleGenerateContentResponse({
			model: "gemini-3.5-flash",
			responseParts: [{ text: "done" }],
			promptTokens: 2,
			candidateTokens: 1,
			upstreamEmpty: true,
			warning: { code: "upstream_empty" },
		});
		assert.equal(response.promptFeedback.warning.code, "upstream_empty");
		assert.equal(
			googleStreamDonePayload("gemini-3.5-flash", 2, 1).usageMetadata
				.totalTokenCount,
			3,
		);
	});
});
