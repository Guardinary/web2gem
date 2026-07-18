import { describe, test } from "vitest";
import { decodeGeminiAccountProbe } from "../../../../src/gemini/accounts/probe";
import { assert } from "../../assertions.js";

function accountProbeWrb(
	statusCode,
	models = [],
	tierFlags = [],
	capabilityFlags = [],
) {
	const payload = [];
	payload[14] = statusCode;
	payload[15] = models;
	payload[16] = tierFlags;
	payload[17] = capabilityFlags;
	return JSON.stringify([["wrb.fr", "otAQ7b", JSON.stringify(payload)]]);
}

describe("Gemini account probe decoding", () => {
	test("decodes a selectable account and bounded model metadata", () => {
		assert.deepEqual(
			decodeGeminiAccountProbe(
				accountProbeWrb(1000, [["model-pro", "Pro", "description"]], [[21]]),
			),
			{
				statusCode: 1000,
				issue: null,
				selectable: true,
				models: [
					{
						modelId: "model-pro",
						displayName: "Pro",
						description: "description",
						available: true,
						capacity: 1,
						capacityField: 13,
						modelNumber: 1,
						discoveryOrder: 0,
					},
				],
			},
		);
	});

	test("rejects unknown statuses and maps an authentication restriction", () => {
		assert.throws(
			() => decodeGeminiAccountProbe(accountProbeWrb(9999)),
			/unknown Gemini account status/,
		);
		assert.deepEqual(decodeGeminiAccountProbe(accountProbeWrb(1016)), {
			statusCode: 1016,
			issue: "auth",
			selectable: false,
			models: [],
		});
	});

	test("applies documented capacity and capacity-field precedence", () => {
		for (const [tierFlags, capabilityFlags, expected] of [
			[[22], [], [2, 13]],
			[[], [115], [4, 12]],
			[[16], [], [3, 12]],
			[[], [106], [3, 12]],
			[[8], [], [2, 12]],
			[[], [19], [2, 12]],
			[[], [], [1, 12]],
		]) {
			const decoded = decodeGeminiAccountProbe(
				accountProbeWrb(
					1000,
					[["model", "Model", ""]],
					tierFlags,
					capabilityFlags,
				),
			);
			assert.deepEqual(
				[decoded.models[0].capacity, decoded.models[0].capacityField],
				expected,
			);
		}
	});

	test("derives guest availability and provider model numbers", () => {
		const decoded = decodeGeminiAccountProbe(
			accountProbeWrb(1016, [
				["fbb127bbb056c959", "Flash", "Guest Flash"],
				["9d8ca3786ebdfbea", "Pro", "Authenticated Pro"],
			]),
		);
		assert.equal(decoded.models[0].available, true);
		assert.equal(decoded.models[0].modelNumber, 1);
		assert.equal(decoded.models[1].available, false);
		assert.equal(decoded.models[1].modelNumber, 3);
	});

	test("drops model records with oversized or missing display metadata", () => {
		assert.deepEqual(
			decodeGeminiAccountProbe(
				accountProbeWrb(1000, [
					["valid-id", "x".repeat(257), "description"],
					["missing-display", "", "description"],
				]),
			).models,
			[],
		);
	});
});
