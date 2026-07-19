// @ts-nocheck
import { describe, test } from "vitest";
import {
	geminiRouteKey,
	knownTierLabel,
	parseGeminiRouteKey,
} from "../../../../src/gemini/accounts/routes";
import { assert } from "../../assertions.js";

describe("Gemini account routes", () => {
	test("round-trips exact route keys and labels known tiers", () => {
		const route = {
			providerModelId: "future-model-extended",
			capacity: 3,
			capacityField: 13,
			modelNumber: 7,
		};
		assert.deepEqual(parseGeminiRouteKey(geminiRouteKey(route)), route);
		assert.equal(
			knownTierLabel({
				providerModelId: "56fdd199312815e2",
				capacity: 4,
				capacityField: 12,
			}),
			"Plus",
		);
	});
});
