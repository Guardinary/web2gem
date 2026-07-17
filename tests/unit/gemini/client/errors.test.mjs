import { describe, test } from "vitest";
import { invalidGeminiCookieError } from "../../../../src/gemini/client/errors";
import { assert } from "../../assertions.js";

describe("Gemini client errors", () => {
	test("redacts cookies from invalid cookie diagnostics", () => {
		const err = invalidGeminiCookieError(
			{ cookie: "SID=bad" },
			403,
			null,
			"rotation_no_update",
		);
		assert.equal(err.code, "invalid_gemini_cookie");
		assert.equal(
			err.reason,
			"RotateCookies completed but did not return an updated cookie",
		);
		assert.match(
			err.message,
			/Diagnostic: RotateCookies completed but did not return an updated cookie\./,
		);
		assert.doesNotMatch(err.message, /SID=bad/);
	});
});
