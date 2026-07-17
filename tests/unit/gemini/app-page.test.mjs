import { describe, test } from "vitest";
import {
	extractGeminiAppPageTokens,
	extractGeminiBuildLabel,
	extractGeminiPushId,
} from "../../../src/gemini/app-page";
import { assert } from "../assertions.js";

function textResponse(text) {
	return new Response(text);
}

describe("Gemini app-page markers", () => {
	test("bounds app page marker scanning for unterminated quoted values", async () => {
		const oversized = `"qKIAYe":"${"x".repeat(10 * 1024)}`;
		assert.deepEqual(
			await extractGeminiAppPageTokens(textResponse(oversized)),
			{},
		);
		assert.equal(await extractGeminiPushId(textResponse(oversized)), "");

		const buildLabel = "boq_assistant-bard-web-server_20260709.09_p0";
		assert.equal(
			await extractGeminiBuildLabel(
				textResponse(`${oversized}\n${buildLabel}`),
			),
			buildLabel,
		);
	});
});
