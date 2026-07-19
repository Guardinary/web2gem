import { describe, test } from "vitest";
import {
	geminiRouteKey,
	knownTierLabel,
	MAX_GEMINI_MODEL_ROUTES,
	validateGeminiModelRoutePolicy,
} from "../../../../src/gemini/accounts/routes";
import type { GeminiRouteTuple } from "../../../../src/gemini/accounts/route-types";
import { assert } from "../../assertions.js";

const BOUNDARY_ROUTES: GeminiRouteTuple[] = [
	{
		providerModelId: "boundary-capacity-1",
		capacity: 1,
		capacityField: 12,
		modelNumber: 1,
	},
	{
		providerModelId: "boundary-capacity-2",
		capacity: 2,
		capacityField: 13,
		modelNumber: 64,
	},
	{
		providerModelId: "boundary-capacity-3",
		capacity: 3,
		capacityField: 12,
		modelNumber: 64,
	},
	{
		providerModelId: "boundary-capacity-4",
		capacity: 4,
		capacityField: 13,
		modelNumber: 1,
	},
];

describe("Gemini account routes", () => {
	test("round-trips exact route keys and labels known tiers", () => {
		const route: GeminiRouteTuple = {
			providerModelId: "future-model-extended",
			capacity: 3,
			capacityField: 13,
			modelNumber: 7,
		};
		assert.equal(geminiRouteKey(route), '["future-model-extended",3,13,7]');
		assert.equal(
			knownTierLabel({
				providerModelId: "56fdd199312815e2",
				capacity: 4,
				capacityField: 12,
			}),
			"Plus",
		);
	});

	test("accepts valid boundary tuples for every public family", () => {
		for (const family of ["pro", "flash", "flash_lite"]) {
			assert.deepEqual(
				validateGeminiModelRoutePolicy(family, BOUNDARY_ROUTES),
				{ routes: BOUNDARY_ROUTES },
			);
		}
	});

	test("rejects invalid families", () => {
		assert.deepEqual(validateGeminiModelRoutePolicy("unknown", []), {
			error: "invalid_family",
		});
	});

	test("rejects duplicate routes", () => {
		const route = BOUNDARY_ROUTES[0];
		if (!route) throw new Error("missing boundary route fixture");
		assert.deepEqual(validateGeminiModelRoutePolicy("pro", [route, route]), {
			error: "duplicate_route",
		});
	});

	test("rejects more than 128 routes", () => {
		const routes = Array.from(
			{ length: MAX_GEMINI_MODEL_ROUTES + 1 },
			(_, index) => ({
				providerModelId: `route-${index}`,
				capacity: 1,
				capacityField: 12,
				modelNumber: 1,
			}),
		);
		assert.deepEqual(validateGeminiModelRoutePolicy("flash", routes), {
			error: "route_limit_exceeded",
		});
	});

	test("rejects invalid route tuples", () => {
		for (const route of [
			{ ...BOUNDARY_ROUTES[0], providerModelId: "invalid route" },
			{ ...BOUNDARY_ROUTES[0], capacity: 0 },
			{ ...BOUNDARY_ROUTES[0], capacityField: 14 },
			{ ...BOUNDARY_ROUTES[0], modelNumber: 65 },
			{ ...BOUNDARY_ROUTES[0], extra: true },
		]) {
			assert.deepEqual(validateGeminiModelRoutePolicy("flash_lite", [route]), {
				error: "invalid_route",
			});
		}
	});
});
