import { describe, test } from "vitest";
import {
	googleGenerateContentResponse,
	googleStreamDonePayload,
} from "../../../../src/http/google/format";
import { isRecord } from "../../../../src/shared/types";
import { assert } from "../../assertions.js";

describe("Google response format", () => {
	test("formats Google response helper payloads", () => {
		const response = googleGenerateContentResponse({
			model: "gemini-3.5-flash",
			responseParts: [{ text: "done" }],
			promptTokens: 2,
			candidateTokens: 1,
		});
		assert.equal(
			"promptFeedback" in response ? response.promptFeedback : undefined,
			undefined,
		);
		const done = googleStreamDonePayload("gemini-3.5-flash", 2, 1);
		if (!isRecord(done.usageMetadata))
			throw new Error("missing usage metadata");
		assert.equal(done.usageMetadata.totalTokenCount, 3);
	});
});
