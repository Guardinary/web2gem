// @ts-nocheck
import { describe, test } from "vitest";
import { EMPTY_UPSTREAM_MSG } from "../../../src/completion/turn";
import { assert } from "../assertions.js";

describe("completion turn error presentation", () => {
	test("renders upstream empty response errors without leaking build hints", async () => {
		assert.match(EMPTY_UPSTREAM_MSG, /empty response/);
		assert.doesNotMatch(EMPTY_UPSTREAM_MSG, /GEMINI_BL/);
	});
});
