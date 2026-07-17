import { innerPayloadFromEnvelope, type WrbEnvelope } from "./parse-envelope";
import { getNested, stringAt } from "./parse-values";

export type GeminiParsedImage = {
	url: string;
	source: "generated" | "web";
	title?: string;
	alt?: string;
	imageId?: string;
	cid?: string;
	rid?: string;
	rcid?: string;
};

export type GeminiCandidateResponse = {
	text: string | null;
	images: GeminiParsedImage[];
	candidateCount: number;
};

export function extractCandidateResponse(
	envelopes: readonly WrbEnvelope[],
): GeminiCandidateResponse {
	const candidateStates = new Map<number, CandidateState>();
	let candidateCount = 0;
	for (const envelope of envelopes) {
		const inner = innerPayloadFromEnvelope(envelope);
		if (!inner) continue;
		const candidates = Array.isArray(inner[4]) ? inner[4] : [];
		const metadata = Array.isArray(inner[1]) ? inner[1] : [];
		candidateCount += candidates.length;
		for (let index = 0; index < candidates.length; index++) {
			const candidate = candidates[index];
			if (!Array.isArray(candidate)) continue;
			const next = parseCandidateState(candidate, index, metadata);
			const prev = candidateStates.get(index);
			if (!prev || shouldReplaceCandidateState(prev, next))
				candidateStates.set(index, next);
		}
	}
	const selected = selectCandidateState([...candidateStates.values()]);
	return {
		text: selected?.text ?? null,
		images: selected ? dedupeImages(selected.images) : [],
		candidateCount,
	};
}

type CandidateState = {
	index: number;
	text: string;
	images: GeminiParsedImage[];
	completed: boolean;
};

function parseCandidateState(
	candidate: unknown[],
	index: number,
	metadata: unknown[],
): CandidateState {
	const texts: string[] = [];
	const directText = stringAt(getNested(candidate, [1, 0]));
	if (directText) texts.push(directText);
	const cardText = stringAt(getNested(candidate, [22, 0]));
	if (cardText) texts.push(cardText);
	const legacyGroup = candidate[1];
	if (!directText && Array.isArray(legacyGroup)) {
		for (const item of legacyGroup) {
			if (typeof item === "string" && item) texts.push(item);
		}
	}

	const images: GeminiParsedImage[] = [];
	const context = candidateContext(candidate, index, metadata);
	appendGeneratedImages(images, getNested(candidate, [12, 7, 0]), context);
	appendGeneratedImages(images, getNested(candidate, [12, 0, "8", 0]), context);
	appendWebImages(images, getNested(candidate, [12, 1]), context);

	return {
		index,
		text: texts.join("\n"),
		images: dedupeImages(images),
		completed: getNested(candidate, [8, 0]) === 2,
	};
}

type CandidateImageContext = {
	cid?: string;
	rid?: string;
	rcid: string;
};

function candidateContext(
	candidate: unknown[],
	index: number,
	metadata: unknown[],
): CandidateImageContext {
	const context: CandidateImageContext = {
		rcid: stringAt(candidate[0]) || stringAt(metadata[2]) || String(index),
	};
	const cid = stringAt(metadata[0]);
	if (cid) context.cid = cid;
	const rid = stringAt(metadata[1]);
	if (rid) context.rid = rid;
	return context;
}

function shouldReplaceCandidateState(
	prev: CandidateState,
	next: CandidateState,
): boolean {
	if (next.completed && !prev.completed) return true;
	if (prev.completed && !next.completed) return false;
	if (next.images.length > prev.images.length) return true;
	return next.text.length >= prev.text.length;
}

function selectCandidateState(states: CandidateState[]): CandidateState | null {
	const sorted = states.sort((a, b) => a.index - b.index);
	return sorted[0] || null;
}

function appendGeneratedImages(
	out: GeminiParsedImage[],
	raw: unknown,
	context: CandidateImageContext,
): void {
	for (const item of generatedImageItems(raw)) {
		const url =
			stringAt(getNested(item, [0, 3, 3])) ||
			stringAt(getNested(item, [0, 0, 0]));
		if (!url) continue;
		const image: GeminiParsedImage = {
			url,
			source: "generated",
			rcid: context.rcid,
		};
		const alt =
			stringAt(getNested(item, [0, 3, 2])) ||
			stringAt(getNested(item, [3, 5, 0]));
		if (alt) image.alt = alt;
		const imageId =
			stringAt(getNested(item, [1, 0])) ||
			`http://googleusercontent.com/image_generation_content/${out.length}`;
		image.imageId = imageId;
		if (context.cid) image.cid = context.cid;
		if (context.rid) image.rid = context.rid;
		out.push(image);
	}
}

function appendWebImages(
	out: GeminiParsedImage[],
	raw: unknown,
	context: CandidateImageContext,
): void {
	for (const item of webImageItems(raw)) {
		const url = stringAt(getNested(item, [0, 0, 0]));
		if (!url) continue;
		const image: GeminiParsedImage = {
			url,
			source: "web",
			rcid: context.rcid,
		};
		const alt = stringAt(getNested(item, [0, 4]));
		if (alt) image.alt = alt;
		const title = stringAt(getNested(item, [7, 0]));
		if (title) image.title = title;
		if (context.cid) image.cid = context.cid;
		if (context.rid) image.rid = context.rid;
		out.push(image);
	}
}

function generatedImageItems(raw: unknown): unknown[] {
	const out: unknown[] = [];
	collectImageItems(raw, out, isGeneratedImageEntry, 0);
	return out;
}

function webImageItems(raw: unknown): unknown[] {
	const out: unknown[] = [];
	collectImageItems(raw, out, isWebImageEntry, 0);
	return out;
}

function collectImageItems(
	raw: unknown,
	out: unknown[],
	isEntry: (value: unknown) => boolean,
	depth: number,
): void {
	if (!Array.isArray(raw) || depth > 5) return;
	if (isEntry(raw)) {
		out.push(raw);
		return;
	}
	for (const item of raw) collectImageItems(item, out, isEntry, depth + 1);
}

function isGeneratedImageEntry(value: unknown): boolean {
	return !!(
		stringAt(getNested(value, [0, 3, 3])) ||
		stringAt(getNested(value, [0, 0, 0]))
	);
}

function isWebImageEntry(value: unknown): boolean {
	return !!stringAt(getNested(value, [0, 0, 0]));
}

function dedupeImages(images: GeminiParsedImage[]): GeminiParsedImage[] {
	const out: GeminiParsedImage[] = [];
	const seen = new Set<string>();
	for (const image of images) {
		const key = image.imageId || image.url;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(image);
	}
	return out;
}
