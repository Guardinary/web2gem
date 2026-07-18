import { describe, test } from "vitest";
import { buildGeminiModelHeaders } from "../../../../src/gemini/client/model-headers";
import { assert } from "../../assertions.js";

const route = {
	providerModelId: "e6fa609c3fa255c0",
	capacity: 4,
	capacityField: 12,
	modelNumber: 3,
};

describe("Gemini model headers", () => {
	test("writes standard capacity into field 12", () => {
		const headers = buildGeminiModelHeaders(route, false, "session-id");
		assert.deepEqual(JSON.parse(headers["x-goog-ext-525001261-jspb"]), [
			1,
			null,
			null,
			null,
			"e6fa609c3fa255c0",
			null,
			null,
			0,
			[4, 5, 6, 8],
			null,
			null,
			4,
			null,
			null,
			3,
			1,
			"SESSION-ID",
		]);
	});

	test("writes extended capacity into field 13 and emits the companion header", () => {
		const headers = buildGeminiModelHeaders(
			{ ...route, capacity: 2, capacityField: 13 },
			true,
			"session-id",
		);
		assert.deepEqual(JSON.parse(headers["x-goog-ext-525001261-jspb"]), [
			1,
			null,
			null,
			null,
			"e6fa609c3fa255c0",
			null,
			null,
			0,
			[4, 5, 6, 8],
			null,
			null,
			null,
			2,
			null,
			null,
			3,
			2,
			"SESSION-ID",
		]);
		assert.equal(headers["x-goog-ext-73010990-jspb"], "[0,0,0]");
	});
});
