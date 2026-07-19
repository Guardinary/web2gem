// @ts-nocheck
import { describe, test } from "vitest";
import {
	invalidGeminiCookieError,
	isInvalidGeminiCookieError,
	unverifiedGeminiCookieError,
} from "../../../../src/gemini/client/errors";
import { openAIUpstreamErrorResponse } from "../../../../src/http/openai/errors";
import { assert } from "../../assertions.js";

describe("OpenAI error mapping", () => {
	test("classifies Gemini authentication failures and maps OpenAI 401 envelopes", async () => {
		const err = invalidGeminiCookieError({ cookie: "SID=bad" }, 403, 123);
		assert.equal(err.code, "invalid_gemini_cookie");
		assert.equal(err.status, 401);
		assert.equal(err.upstreamStatus, 403);
		assert.equal(err.rawLength, 123);
		assert.equal(isInvalidGeminiCookieError(err), true);
		assert.equal(invalidGeminiCookieError({ cookie: "" }, 403), null);
		assert.equal(invalidGeminiCookieError({ cookie: "SID=bad" }, 429), null);

		const openAIResp = openAIUpstreamErrorResponse(err);
		assert.equal(openAIResp.status, 401);
		const openAIBody = await openAIResp.json();
		assert.equal(openAIBody.error.code, "invalid_gemini_cookie");
		assert.equal(openAIBody.error.type, "authentication_error");
		const earlyErr = invalidGeminiCookieError({ cookie: "SID=bad" }, 401);
		assert.equal(earlyErr.rawLength, null);

		const unverifiedErr = unverifiedGeminiCookieError();
		assert.equal(unverifiedErr.code, "invalid_gemini_cookie");
		assert.equal(unverifiedErr.status, 401);
		const unverifiedResp = openAIUpstreamErrorResponse(unverifiedErr);
		assert.equal(unverifiedResp.status, 401);
		assert.equal(
			(await unverifiedResp.json()).error.type,
			"authentication_error",
		);
	});
});
