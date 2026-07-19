import { describe, test } from "vitest";
import {
	cleanText,
	extractResponseFatalCode,
	extractResponseParts,
	extractResponseText,
	richResponseShapeSummary,
	stripArtifacts,
} from "../../../../src/gemini/client/parse-parts";
import { assert } from "../../assertions.js";

function framedWrbRaw(candidate: unknown[]) {
	const inner = [
		null,
		["cid_1", "rid_1", "rcid_meta"],
		null,
		null,
		[candidate],
		"x".repeat(160),
	];
	const payload = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
	const emptyPayload = JSON.stringify([
		[
			"wrb.fr",
			null,
			JSON.stringify([null, null, null, null, [], "x".repeat(160)]),
		],
	]);
	return `)]}'\n\n${payload.length}\n${payload}${emptyPayload.length}\n${emptyPayload}`;
}

function wrbLine(candidate: unknown[]) {
	const inner = [null, null, null, null, [candidate], "x".repeat(160)];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

function fatalWrbLine(code: number, location = "inner") {
	const inner: unknown[] = [null, null, null, null, []];
	const envelope: unknown[] = ["wrb.fr", null, JSON.stringify(inner)];
	const target = location === "envelope" ? envelope : inner;
	const codeEntry: unknown[] = [];
	codeEntry[1] = [code];
	const codeGroup: unknown[] = [codeEntry];
	const fatalParts: unknown[] = [];
	fatalParts[2] = codeGroup;
	target[5] = fatalParts;
	if (location !== "envelope") envelope[2] = JSON.stringify(inner);
	return JSON.stringify([envelope]);
}

function generatedImageEntry(
	url = "https://lh3.googleusercontent.com/generated=s1024-rj",
	id = "img_1",
) {
	const detail: unknown[] = [];
	detail[2] = "generated alt";
	detail[3] = url;
	const meta: unknown[] = [];
	meta[3] = detail;
	return [meta, [id]];
}

function generatedImageCandidate(
	text = "final text",
	url = "https://lh3.googleusercontent.com/generated=s1024-rj",
) {
	const candidate: unknown[] = [];
	candidate[1] = [text];
	candidate[8] = [2];
	const rich: unknown[] = [];
	rich[7] = [[generatedImageEntry(url)]];
	candidate[12] = rich;
	return candidate;
}

describe("Gemini response parts", () => {
	test("strips generated code artifacts from Gemini text", () => {
		const source = [
			"keep",
			"```python?code_reference&code_event_index=1",
			"drop",
			"```",
			"http://googleusercontent.com/card_content/123",
			"http://googleusercontent.com/image_generation_content/0",
		].join("\n");
		assert.equal(stripArtifacts(source).trim(), "keep");
		assert.equal(cleanText(`  ${source}  `), "keep");
	});
	test("selects the longest cleaned response text", () => {
		const short = generatedImageCandidate("short");
		const long = generatedImageCandidate(
			"long answer\n```python?code_reference&code_event_index=1\nhidden\n```",
		);
		const raw = [wrbLine(short), wrbLine(long)].join("\n");
		assert.equal(extractResponseText(raw), "long answer");
	});
	test("handles malformed rich envelopes without throwing", () => {
		assert.equal(extractResponseParts(null).text, "");
		assert.equal(
			extractResponseParts(JSON.stringify([["wrb.fr", null, null]]))
				.candidateCount,
			0,
		);
		assert.equal(
			extractResponseParts(JSON.stringify([["wrb.fr", null, "{"]]))
				.candidateCount,
			0,
		);
		assert.equal(
			extractResponseParts(
				JSON.stringify([
					[
						"wrb.fr",
						null,
						JSON.stringify([null, null, null, null, ["not an array"]]),
					],
				]),
			).candidateCount,
			1,
		);
	});
	test("strips generated-image placeholders while preserving image metadata", () => {
		const raw = wrbLine(
			generatedImageCandidate(
				"http://googleusercontent.com/image_generation_content/0",
			),
		);
		const parts = extractResponseParts(raw);
		assert.equal(parts.text, "");
		assert.equal(parts.generatedImageCount, 1);
		assert.match(richResponseShapeSummary(raw), /generatedImages=1/);
	});
	test("extracts rich generated images from length-prefixed frames", () => {
		const candidate = generatedImageCandidate("image 🟦 ready");
		candidate[0] = "rcid_1";
		const raw = framedWrbRaw(candidate);
		const parts = extractResponseParts(raw);
		assert.equal(parts.text, "image 🟦 ready");
		assert.equal(parts.generatedImageCount, 1);
		assert.equal(
			parts.images[0]?.url,
			"https://lh3.googleusercontent.com/generated=s1024-rj",
		);
		assert.equal(parts.images[0]?.cid, "cid_1");
		assert.equal(parts.images[0]?.rid, "rid_1");
		assert.equal(parts.images[0]?.rcid, "rcid_1");
	});
	test("maps numeric Gemini fatal part codes from inner payloads and envelopes", () => {
		for (const code of [1013, 1037, 1050, 1052, 1060]) {
			for (const location of ["inner", "envelope"]) {
				const raw = fatalWrbLine(code, location);
				assert.equal(extractResponseParts(raw).fatalCode, String(code));
				assert.equal(extractResponseFatalCode(raw), String(code));
			}
		}
		assert.match(
			richResponseShapeSummary(fatalWrbLine(1060)),
			/fatalCode=1060/,
		);
	});
});
