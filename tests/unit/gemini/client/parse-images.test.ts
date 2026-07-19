import { describe, test } from "vitest";
import { parseWrbEnvelopes } from "../../../../src/gemini/client/parse-envelope";
import {
	extractCandidateResponse,
	type GeminiParsedImage,
} from "../../../../src/gemini/client/parse-images";
import { assert } from "../../assertions.js";

function richWrbLine(candidate: unknown[]) {
	const inner = [null, null, null, null, [candidate], "x".repeat(160)];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
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
	setGeneratedImageEntries(candidate, [generatedImageEntry(url)]);
	return candidate;
}

function setGeneratedImageEntries(
	candidate: unknown[],
	entries: unknown[],
): void {
	const rich: unknown[] = [];
	rich[7] = [entries];
	candidate[12] = rich;
}

function setImageToImageEntries(
	candidate: unknown[],
	entries: unknown[],
): void {
	const rich: unknown[] = [];
	rich[0] = { 8: [entries] };
	candidate[12] = rich;
}

function webImageEntry(url = "https://images.example/web.png") {
	const meta: unknown[] = [];
	meta[0] = [url];
	meta[4] = "web alt";
	const entry: unknown[] = [];
	entry[0] = meta;
	entry[7] = ["web title"];
	return entry;
}

function webImageCandidate(
	text = "web result",
	url = "https://images.example/web.png",
) {
	const candidate: unknown[] = [];
	candidate[22] = [text];
	candidate[8] = [2];
	const rich: unknown[] = [];
	rich[1] = [[webImageEntry(url)]];
	candidate[12] = rich;
	return candidate;
}

function candidateResponse(raw: string) {
	return extractCandidateResponse(parseWrbEnvelopes(raw));
}

function imageAt(images: readonly GeminiParsedImage[], index: number) {
	const image = images[index];
	if (!image) throw new Error(`missing image ${index}`);
	return image;
}

describe("Gemini candidate images", () => {
	test("extracts generated image metadata from the selected candidate", () => {
		const raw = richWrbLine(generatedImageCandidate("image ready"));
		const parts = candidateResponse(raw);
		assert.equal(parts.text, "image ready");
		assert.equal(parts.images.length, 1);
		assert.equal(imageAt(parts.images, 0).source, "generated");
		assert.equal(
			imageAt(parts.images, 0).url,
			"https://lh3.googleusercontent.com/generated=s1024-rj",
		);
		assert.equal(imageAt(parts.images, 0).imageId, "img_1");
	});
	test("extracts rich web image metadata and card text", () => {
		const raw = richWrbLine(webImageCandidate("card answer"));
		const parts = candidateResponse(raw);
		assert.equal(parts.text, "card answer");
		assert.equal(parts.images.length, 1);
		assert.equal(imageAt(parts.images, 0).source, "web");
		assert.equal(
			imageAt(parts.images, 0).url,
			"https://images.example/web.png",
		);
		assert.equal(imageAt(parts.images, 0).alt, "web alt");
		assert.equal(imageAt(parts.images, 0).title, "web title");
	});
	test("prefers completed or richer repeated candidate states", () => {
		const incompleteTextOnly: unknown[] = [];
		incompleteTextOnly[1] = ["draft"];

		const completedGenerated = generatedImageCandidate("final");
		const completedFirst = [
			richWrbLine(incompleteTextOnly),
			richWrbLine(completedGenerated),
		].join("\n");
		const completedParts = candidateResponse(completedFirst);
		assert.equal(completedParts.text, "final");
		assert.equal(completedParts.images.length, 1);

		const laterIncomplete = generatedImageCandidate(
			"later incomplete with longer text",
		);
		laterIncomplete[8] = [1];
		const keepCompleted = [
			richWrbLine(completedGenerated),
			richWrbLine(laterIncomplete),
		].join("\n");
		const keepCompletedParts = candidateResponse(keepCompleted);
		assert.equal(keepCompletedParts.text, "final");
		assert.equal(keepCompletedParts.images.length, 1);

		const richerIncomplete = generatedImageCandidate("richer");
		richerIncomplete[8] = [1];
		const richerParts = candidateResponse(
			[richWrbLine(incompleteTextOnly), richWrbLine(richerIncomplete)].join(
				"\n",
			),
		);
		assert.equal(richerParts.text, "richer");
		assert.equal(richerParts.images.length, 1);
	});
	test("extracts image-to-image generated image path and does not merge alternatives", () => {
		const first: unknown[] = [];
		first[1] = ["first candidate"];
		first[8] = [2];
		setImageToImageEntries(first, [
			generatedImageEntry(
				"https://lh3.googleusercontent.com/first=s1024-rj",
				"first-id",
			),
		]);

		const second = generatedImageCandidate("second candidate");
		setGeneratedImageEntries(second, [
			generatedImageEntry(
				"https://lh3.googleusercontent.com/second=s1024-rj",
				"second-id",
			),
		]);

		const inner = [null, null, null, null, [first, second], "x".repeat(160)];
		const raw = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
		const parts = candidateResponse(raw);
		assert.equal(parts.text, "first candidate");
		assert.equal(parts.images.length, 1);
		assert.equal(
			imageAt(parts.images, 0).url,
			"https://lh3.googleusercontent.com/first=s1024-rj",
		);
	});
	test("does not attach alternative candidate text to selected image-only candidate", () => {
		const imageOnly = generatedImageCandidate("");
		const textOnly: unknown[] = [];
		textOnly[1] = ["alternative candidate text"];
		textOnly[8] = [2];

		const inner = [
			null,
			null,
			null,
			null,
			[imageOnly, textOnly],
			"x".repeat(160),
		];
		const raw = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
		const parts = candidateResponse(raw);
		assert.equal(parts.text, "");
		assert.equal(parts.images.length, 1);
		assert.equal(
			imageAt(parts.images, 0).url,
			"https://lh3.googleusercontent.com/generated=s1024-rj",
		);
	});
	test("keeps default first-candidate selection even when alternatives contain images", () => {
		const selectedTextOnly: unknown[] = [];
		selectedTextOnly[1] = ["selected text only"];
		selectedTextOnly[8] = [2];

		const alternativeImage = generatedImageCandidate("alternative image");
		setGeneratedImageEntries(alternativeImage, [
			generatedImageEntry(
				"https://lh3.googleusercontent.com/alternative=s1024-rj",
				"alt-id",
			),
		]);

		const inner = [
			null,
			null,
			null,
			null,
			[selectedTextOnly, alternativeImage],
			"x".repeat(160),
		];
		const raw = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
		const parts = candidateResponse(raw);
		assert.equal(parts.text, "selected text only");
		assert.equal(parts.images.length, 0);
	});
	test("dedupes repeated image IDs within the selected candidate", () => {
		const candidate = generatedImageCandidate("done");
		setGeneratedImageEntries(candidate, [
			generatedImageEntry(
				"https://lh3.googleusercontent.com/first=s1024-rj",
				"same-image-id",
			),
			generatedImageEntry(
				"https://lh3.googleusercontent.com/duplicate=s1024-rj",
				"same-image-id",
			),
		]);
		const raw = richWrbLine(candidate);
		const parts = candidateResponse(raw);
		assert.equal(parts.text, "done");
		assert.equal(parts.images.length, 1);
		assert.equal(imageAt(parts.images, 0).imageId, "same-image-id");
		assert.equal(
			imageAt(parts.images, 0).url,
			"https://lh3.googleusercontent.com/first=s1024-rj",
		);
	});
});
