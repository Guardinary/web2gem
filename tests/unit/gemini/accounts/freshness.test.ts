import { describe, test } from "vitest";
import { capabilityFreshAfterMs } from "../../../../src/gemini/accounts/freshness";
import { assert } from "../../assertions.js";

describe("Gemini account capability freshness", () => {
	test("defaults the capability TTL to 3600 seconds", () => {
		assert.equal(capabilityFreshAfterMs(undefined, 5_000_000), 1_400_000);
	});

	test("clamps the capability TTL to a 60 second minimum", () => {
		assert.equal(capabilityFreshAfterMs(30, 5_000_000), 4_940_000);
	});

	test("uses the explicit TTL and current time", () => {
		assert.equal(capabilityFreshAfterMs(900, 2_000_000), 1_100_000);
	});
});
