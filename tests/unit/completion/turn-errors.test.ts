// @ts-nocheck
import { describe, test } from "vitest";
import {
	EMPTY_UPSTREAM_MSG,
	upstreamEmptyWarning,
} from "../../../src/completion/turn";
import { assert } from "../assertions.js";

describe("completion turn error presentation", () => {
	test("renders upstream empty response warning without leaking build hints", async () => {
		assert.match(EMPTY_UPSTREAM_MSG, /empty response/);
		assert.doesNotMatch(EMPTY_UPSTREAM_MSG, /GEMINI_BL/);
		const warning = upstreamEmptyWarning({ gemini_bl: "boq_test" });
		assert.equal(warning.code, "upstream_empty");
		assert.equal(warning.gemini_bl, "boq_test");
		assert.match(warning.hint, /diagnostics/);
	});
});
