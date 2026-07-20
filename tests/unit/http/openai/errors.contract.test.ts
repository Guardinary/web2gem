import { describe, test } from "vitest";
import {
	invalidGeminiCookieError,
	isInvalidGeminiCookieError,
	unverifiedGeminiCookieError,
} from "../../../../src/gemini/client/errors";
import { openAIUpstreamErrorResponse } from "../../../../src/http/openai/errors";
import { isRecord, type UnknownRecord } from "../../../../src/shared/types";
import { assert } from "../../assertions.js";

function record(value: unknown, label: string): UnknownRecord {
	if (!isRecord(value)) throw new Error(`expected ${label} object`);
	return value;
}

function required<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined)
		throw new Error(`${label} is required`);
	return value;
}

describe("OpenAI error mapping", () => {
	test("classifies Gemini authentication failures and maps OpenAI 401 envelopes", async () => {
		const err = required(
			invalidGeminiCookieError({ cookie: "SID=bad" }, 403, 123),
			"invalid cookie error",
		);
		assert.equal(err.code, "invalid_gemini_cookie");
		assert.equal(err.status, 401);
		assert.equal(err.upstreamStatus, 403);
		assert.equal(err.rawLength, 123);
		assert.equal(isInvalidGeminiCookieError(err), true);
		assert.equal(invalidGeminiCookieError({ cookie: "" }, 403), null);
		assert.equal(invalidGeminiCookieError({ cookie: "SID=bad" }, 429), null);

		const openAIResp = openAIUpstreamErrorResponse(err);
		assert.equal(openAIResp.status, 401);
		const openAIBody = record(await openAIResp.json(), "OpenAI");
		const openAIError = record(openAIBody.error, "OpenAI error");
		assert.equal(openAIError.code, "invalid_gemini_cookie");
		assert.equal(openAIError.type, "authentication_error");
		const earlyErr = required(
			invalidGeminiCookieError({ cookie: "SID=bad" }, 401),
			"early error",
		);
		assert.equal(earlyErr.rawLength, null);

		const unverifiedErr = unverifiedGeminiCookieError();
		assert.equal(unverifiedErr.code, "invalid_gemini_cookie");
		assert.equal(unverifiedErr.status, 401);
		const unverifiedResp = openAIUpstreamErrorResponse(unverifiedErr);
		assert.equal(unverifiedResp.status, 401);
		const unverifiedBody = record(
			await unverifiedResp.json(),
			"unverified OpenAI",
		);
		assert.equal(
			record(unverifiedBody.error, "unverified OpenAI error").type,
			"authentication_error",
		);
	});
});
