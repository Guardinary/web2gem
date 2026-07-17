import { describe, test } from "vitest";
import {
	extractTextsFromLine,
	parseWrbEnvelopes,
	wrbResponseShapeSummary,
} from "../../../../src/gemini/client/parse-envelope";
import { assert } from "../../assertions.js";

function wrbLine(texts) {
	const inner = [null, null, null, null, [[null, texts]], "x".repeat(160)];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

describe("Gemini WRB envelopes", () => {
	test("extracts text arrays from valid WRB envelopes", () => {
		const line = wrbLine(["short", "longer response"]);
		assert.deepEqual(extractTextsFromLine(line), ["short", "longer response"]);
		assert.deepEqual(extractTextsFromLine(` \t${line}`), [
			"short",
			"longer response",
		]);
		assert.deepEqual(
			extractTextsFromLine(
				JSON.stringify([
					[
						"wrb.fr",
						null,
						JSON.stringify([null, null, null, null, [[null, ["tiny"]]]]),
					],
				]),
			),
			["tiny"],
		);
		assert.deepEqual(extractTextsFromLine("not json"), []);
		assert.deepEqual(extractTextsFromLine(`${"x".repeat(220)} "wrb.fr"`), []);
		assert.deepEqual(
			extractTextsFromLine(JSON.stringify([["wrb.fr", null, "{"]])),
			[],
		);
		assert.match(
			wrbResponseShapeSummary(JSON.stringify([["wrb.fr", null, "{"]])),
			/topIssue=invalid_inner_json:1/,
		);

		const raw = [wrbLine(["first"]), wrbLine(["first plus more"])].join("\n");
		assert.match(wrbResponseShapeSummary(raw), /wrbLines=2/);
		assert.match(wrbResponseShapeSummary(raw), /textParts=2/);
	});
	test("summarizes WRB parse issue branches without throwing", () => {
		const parseIssueInputs = [
			JSON.stringify({ not: "an array" }),
			JSON.stringify([["wrb.fr", null, null]]),
			JSON.stringify([["wrb.fr", null, JSON.stringify([null])]]),
			JSON.stringify([
				["wrb.fr", null, JSON.stringify([null, null, null, null, "not parts"])],
			]),
			JSON.stringify([
				[
					"wrb.fr",
					null,
					JSON.stringify([null, null, null, null, [[null, []]]]),
				],
			]),
		];
		const summary = wrbResponseShapeSummary(parseIssueInputs.join("\n"));
		assert.match(summary, /wrbLines=4/);
		assert.match(summary, /parsedEnvelopes=4/);
		assert.match(summary, /parsedInnerPayloads=3/);
		assert.deepEqual(
			parseIssueInputs.map((item) => extractTextsFromLine(item)),
			[[], [], [], [], []],
		);
	});
	test("ignores invalid length-prefixed frames without throwing", () => {
		for (const raw of [
			")]}'\n\n0\n[]",
			")]}'\n\n999\n[]",
			")]}'\n\n5\nnot-json",
			")]}'\n\n1x\n[]",
		])
			assert.deepEqual(parseWrbEnvelopes(raw), []);
	});
});
