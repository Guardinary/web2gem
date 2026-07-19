// @ts-nocheck
import { describe, test } from "vitest";
import { firstNonEmptyString } from "../../../src/shared/strings";
import { assert } from "../assertions.js";

describe("shared strings", () => {
	test("selects the first non-empty shared string", () => {
		assert.equal(firstNonEmptyString(null, "  ", " ok "), "ok");
	});
});
