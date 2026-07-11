import { trimContinuationOverlap } from "../../shared/tokens";

const STREAM_APPEND_PROBE_CHARS = 64;

type WrbLineParseIssue =
	| "ok"
	| "not_wrb_line"
	| "invalid_envelope_json"
	| "invalid_envelope_shape"
	| "missing_inner_payload"
	| "invalid_inner_json"
	| "invalid_inner_shape"
	| "missing_text_parts"
	| "empty_text_parts";

type WrbLineParseResult = {
	texts: string[];
	issue: WrbLineParseIssue;
	parsedEnvelope: boolean;
	parsedInner: boolean;
};

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

export type GeminiResponseParts = {
	text: string;
	images: GeminiParsedImage[];
	fatalCode?: string;
	candidateCount: number;
	generatedImageCount: number;
	webImageCount: number;
};

export function stripArtifacts(text: unknown): string {
	let source = String(text || "");
	if (!source) return "";
	if (source.indexOf("```") >= 0 && source.indexOf("code_event_index=") >= 0) {
		source = source.replace(
			/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g,
			"",
		);
	}
	if (source.indexOf("http://googleusercontent.com/") >= 0) {
		source = source.replace(
			/http:\/\/googleusercontent\.com\/\w+\/\d+\n*/g,
			"",
		);
	}
	return source;
}

function hasArtifactMarkers(source: string): boolean {
	return (
		(source.indexOf("```") >= 0 && source.indexOf("code_event_index=") >= 0) ||
		source.indexOf("http://googleusercontent.com/") >= 0
	);
}

export function cleanText(text: unknown): string {
	return stripArtifacts(text).trim();
}

export function extractTextsFromLine(line: unknown): string[] {
	return parseWrbLine(line).texts;
}

export function wrbResponseShapeSummary(raw: unknown): string {
	const source = String(raw || "");
	let lines = 0;
	let wrbLines = 0;
	let parsedEnvelopes = 0;
	let parsedInners = 0;
	let textParts = 0;
	const issues: Record<string, number> = {};
	for (const line of iterateLines(source)) {
		if (!line) continue;
		lines += 1;
		const parsed = parseWrbLine(line);
		if (parsed.issue === "not_wrb_line") continue;
		wrbLines += 1;
		if (parsed.parsedEnvelope) parsedEnvelopes += 1;
		if (parsed.parsedInner) parsedInners += 1;
		textParts += parsed.texts.length;
		if (parsed.issue !== "ok")
			issues[parsed.issue] = (issues[parsed.issue] || 0) + 1;
	}
	const topIssue = Object.entries(issues).sort((a, b) => b[1] - a[1])[0];
	return [
		`lines=${lines}`,
		`wrbLines=${wrbLines}`,
		`parsedEnvelopes=${parsedEnvelopes}`,
		`parsedInnerPayloads=${parsedInners}`,
		`textParts=${textParts}`,
		topIssue ? `topIssue=${topIssue[0]}:${topIssue[1]}` : "",
	]
		.filter(Boolean)
		.join(" ");
}

export function richResponseShapeSummary(raw: unknown): string {
	const parts = extractResponseParts(raw);
	return [
		`candidates=${parts.candidateCount}`,
		`generatedImages=${parts.generatedImageCount}`,
		`webImages=${parts.webImageCount}`,
		parts.fatalCode ? `fatalCode=${parts.fatalCode}` : "",
		wrbResponseShapeSummary(raw),
	]
		.filter(Boolean)
		.join(" ");
}

function parseWrbLine(line: unknown): WrbLineParseResult {
	const source = String(line || "");
	if (!isWrbResponseLineCandidate(source)) return wrbLineIssue("not_wrb_line");
	let arr: unknown;
	try {
		arr = JSON.parse(source);
	} catch (_) {
		return wrbLineIssue("invalid_envelope_json");
	}
	if (!Array.isArray(arr) || !Array.isArray(arr[0]))
		return wrbLineIssue("invalid_envelope_shape");
	const innerStr = arr[0][2];
	if (typeof innerStr !== "string")
		return wrbLineIssue("missing_inner_payload", true);
	let inner: unknown;
	try {
		inner = JSON.parse(innerStr);
	} catch (_) {
		return wrbLineIssue("invalid_inner_json", true);
	}
	if (!(Array.isArray(inner) && inner.length > 4))
		return wrbLineIssue("invalid_inner_shape", true, true);
	const textGroups = inner[4];
	if (!Array.isArray(textGroups))
		return wrbLineIssue("missing_text_parts", true, true);
	const texts: string[] = [];
	for (const part of textGroups) {
		if (
			Array.isArray(part) &&
			part.length > 1 &&
			part[1] &&
			Array.isArray(part[1])
		) {
			for (const t of part[1]) {
				if (typeof t === "string" && t) texts.push(t);
			}
		}
	}
	return {
		texts,
		issue: texts.length ? "ok" : "empty_text_parts",
		parsedEnvelope: true,
		parsedInner: true,
	};
}

function wrbLineIssue(
	issue: WrbLineParseIssue,
	parsedEnvelope = false,
	parsedInner = false,
): WrbLineParseResult {
	return { texts: [], issue, parsedEnvelope, parsedInner };
}

function isWrbResponseLineCandidate(source: string): boolean {
	let i = skipJsonWhitespace(source, 0);
	if (source.charCodeAt(i) !== 91) return false; // [
	i = skipJsonWhitespace(source, i + 1);
	if (source.charCodeAt(i) !== 91) return false; // [
	i = skipJsonWhitespace(source, i + 1);
	return source.startsWith('"wrb.fr"', i);
}

function skipJsonWhitespace(source: string, index: number): number {
	let cursor = index;
	while (cursor < source.length) {
		const c = source.charCodeAt(cursor);
		if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
		cursor += 1;
	}
	return cursor;
}

export function extractResponseText(raw: unknown): string {
	let lastText = "";
	const source = String(raw || "");
	for (const line of iterateLines(source)) {
		for (const t of extractTextsFromLine(line)) {
			if (t.length > lastText.length) lastText = t;
		}
	}
	return cleanText(lastText);
}

export function extractResponseParts(raw: unknown): GeminiResponseParts {
	const candidateStates = new Map<number, CandidateState>();
	let candidateCount = 0;
	let fatalCode = "";
	const source = String(raw || "");
	for (const envelope of parseWrbEnvelopes(source)) {
		fatalCode ||= fatalCodeFromEnvelope(envelope);
		const inner = innerPayloadFromEnvelope(envelope);
		if (!inner) continue;
		fatalCode ||= fatalCodeFromInner(inner);
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
	const images = selected ? dedupeImages(selected.images) : [];
	const generatedImageCount = images.filter(
		(image) => image.source === "generated",
	).length;
	const webImageCount = images.filter((image) => image.source === "web").length;
	const text = selected ? cleanText(selected.text) : extractResponseText(raw);
	const out: GeminiResponseParts = {
		text,
		images,
		candidateCount,
		generatedImageCount,
		webImageCount,
	};
	if (fatalCode) out.fatalCode = fatalCode;
	return out;
}

function parseWrbEnvelopes(source: string): unknown[][] {
	const framed = parseFramedWrbEnvelopes(source);
	if (framed.length) return framed;
	const out: unknown[][] = [];
	for (const line of iterateLines(source))
		out.push(...parseWrbEnvelopeJson(line));
	return out;
}

function parseWrbEnvelopeJson(sourceValue: unknown): unknown[][] {
	const source = String(sourceValue || "");
	let arr: unknown;
	try {
		arr = JSON.parse(source);
	} catch (_) {
		return [];
	}
	return collectWrbEnvelopes(arr);
}

function innerPayloadFromEnvelope(envelope: unknown[]): unknown[] | null {
	const innerStr = envelope[2];
	if (typeof innerStr !== "string") return null;
	let inner: unknown;
	try {
		inner = JSON.parse(innerStr);
	} catch (_) {
		return null;
	}
	return Array.isArray(inner) ? inner : null;
}

function parseFramedWrbEnvelopes(raw: string): unknown[][] {
	let source = raw;
	if (source.startsWith(")]}'")) source = source.slice(4).trimStart();
	const out: unknown[][] = [];
	let pos = 0;
	while (pos < source.length) {
		pos = skipFrameWhitespace(source, pos);
		if (pos >= source.length) break;
		const marker = readFrameLengthMarker(source, pos);
		if (!marker) break;
		const { frameLength, contentStart } = marker;
		const contentEnd = contentStart + frameLength;
		if (contentEnd > source.length) break;
		const chunk = source.slice(contentStart, contentEnd).trim();
		pos = contentEnd;
		if (!chunk) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(chunk);
		} catch (_) {
			continue;
		}
		out.push(...collectWrbEnvelopes(parsed));
	}
	return out;
}

function readFrameLengthMarker(
	source: string,
	pos: number,
): { frameLength: number; contentStart: number } | null {
	let i = pos;
	let frameLength = 0;
	while (i < source.length) {
		const code = source.charCodeAt(i);
		if (code === 10) {
			if (i === pos || !Number.isSafeInteger(frameLength) || frameLength <= 0)
				return null;
			return { frameLength, contentStart: i + 1 };
		}
		if (code < 48 || code > 57) return null;
		frameLength = frameLength * 10 + code - 48;
		if (!Number.isSafeInteger(frameLength)) return null;
		i += 1;
	}
	return null;
}

function skipFrameWhitespace(source: string, index: number): number {
	let i = index;
	while (i < source.length) {
		const c = source.charCodeAt(i);
		if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
		i += 1;
	}
	return i;
}

function collectWrbEnvelopes(value: unknown): unknown[][] {
	const out: unknown[][] = [];
	collectWrbEnvelopesInto(value, out, 0);
	return out;
}

function collectWrbEnvelopesInto(
	value: unknown,
	out: unknown[][],
	depth: number,
): void {
	if (!Array.isArray(value) || depth > 3) return;
	if (isWrbEnvelope(value)) {
		out.push(value);
		return;
	}
	for (const item of value) collectWrbEnvelopesInto(item, out, depth + 1);
}

function isWrbEnvelope(value: unknown[]): value is unknown[] {
	return value[0] === "wrb.fr" && typeof value[2] === "string";
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

function fatalCodeFromInner(inner: unknown[]): string {
	return stableFatalCode(getNested(inner, [5, 2, 0, 1, 0]));
}

function fatalCodeFromEnvelope(envelope: unknown[]): string {
	return stableFatalCode(getNested(envelope, [5, 2, 0, 1, 0]));
}

function stableFatalCode(code: unknown): string {
	const normalized =
		typeof code === "string" || typeof code === "number"
			? String(code).trim()
			: "";
	switch (normalized) {
		case "1013":
		case "1037":
		case "1050":
		case "1052":
		case "1060":
			return normalized;
		default:
			return "";
	}
}

function getNested(
	value: unknown,
	path: readonly (number | string)[],
): unknown {
	let cur = value;
	for (const key of path) {
		if (Array.isArray(cur) && typeof key === "number") {
			cur = cur[key];
			continue;
		}
		if (isObjectLike(cur) && typeof key === "string") {
			cur = cur[key];
			continue;
		}
		return undefined;
	}
	return cur;
}

function stringAt(value: unknown): string {
	return typeof value === "string" && value.trim() ? value : "";
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function* iterateLines(source: string): Generator<string> {
	let start = 0;
	while (start <= source.length) {
		const idx = source.indexOf("\n", start);
		if (idx < 0) {
			yield source.slice(start);
			return;
		}
		yield source.slice(start, idx);
		start = idx + 1;
	}
}

export function createStreamTextExtractor() {
	let prevVisibleParts: string[] = [];
	let prevVisibleMaterialized: string | null = "";
	let prevVisibleLength = 0;
	let prevVisibleHead = "";
	let prevVisibleTail = "";
	let prevRaw = "";
	let prevRawLength = 0;
	let prevRawHead = "";
	let prevRawTail = "";
	let prevRawHasArtifacts = false;
	let started = false;
	const rememberRaw = (raw: string) => {
		prevRawLength = raw.length;
		prevRaw = raw.length <= STREAM_APPEND_PROBE_CHARS * 2 ? raw : "";
		prevRawHead = raw.slice(0, STREAM_APPEND_PROBE_CHARS);
		prevRawTail = raw.slice(-STREAM_APPEND_PROBE_CHARS);
		prevRawHasArtifacts = hasArtifactMarkers(raw);
	};
	const rememberVisible = (visible: string) => {
		prevVisibleParts = visible ? [visible] : [];
		prevVisibleMaterialized = visible;
		prevVisibleLength = visible.length;
		prevVisibleHead = visible.slice(0, STREAM_APPEND_PROBE_CHARS);
		prevVisibleTail = visible.slice(-STREAM_APPEND_PROBE_CHARS);
	};
	const materializeVisible = () => {
		if (prevVisibleMaterialized !== null) return prevVisibleMaterialized;
		const visible = prevVisibleParts.join("");
		prevVisibleParts = visible ? [visible] : [];
		prevVisibleMaterialized = visible;
		return visible;
	};
	const appendVisibleDelta = (delta: string) => {
		if (!delta) return;
		const oldLength = prevVisibleLength;
		prevVisibleParts.push(delta);
		prevVisibleMaterialized = null;
		prevVisibleLength += delta.length;
		if (oldLength < STREAM_APPEND_PROBE_CHARS) {
			prevVisibleHead = `${prevVisibleHead}${delta}`.slice(
				0,
				STREAM_APPEND_PROBE_CHARS,
			);
		}
		prevVisibleTail = `${prevVisibleTail}${delta}`.slice(
			-STREAM_APPEND_PROBE_CHARS,
		);
	};
	const rawAppendDelta = (raw: string): string | null => {
		if (!prevRawLength || raw.length <= prevRawLength || prevRawHasArtifacts)
			return null;
		if (prevRawLength <= STREAM_APPEND_PROBE_CHARS * 2) {
			if (!raw.startsWith(prevRaw)) return null;
		} else if (
			raw.slice(0, prevRawHead.length) !== prevRawHead ||
			raw.slice(prevRawLength - prevRawTail.length, prevRawLength) !==
				prevRawTail
		) {
			return null;
		}
		const delta = raw.slice(prevRawLength);
		if (hasArtifactMarkers(prevRawTail + delta)) return null;
		return delta;
	};
	const visibleAppendDelta = (visible: string): string | null => {
		if (!prevVisibleLength || visible.length <= prevVisibleLength) return null;
		if (prevVisibleLength <= STREAM_APPEND_PROBE_CHARS * 2) {
			if (!visible.startsWith(materializeVisible())) return null;
		} else if (
			visible.slice(0, prevVisibleHead.length) !== prevVisibleHead ||
			visible.slice(
				prevVisibleLength - prevVisibleTail.length,
				prevVisibleLength,
			) !== prevVisibleTail
		) {
			return null;
		}
		return visible.slice(prevVisibleLength);
	};
	const consumeLine = function* (line: unknown): Generator<string> {
		for (const t of extractTextsFromLine(line)) {
			const raw = String(t || "");
			let delta = "";
			const appendedRawDelta = rawAppendDelta(raw);
			if (appendedRawDelta !== null) {
				delta = appendedRawDelta;
				appendVisibleDelta(delta);
				rememberRaw(raw);
			} else {
				const visible = stripArtifacts(raw);
				if (!prevVisibleLength) {
					delta = visible;
					rememberVisible(visible);
					rememberRaw(raw);
				} else {
					const appendedVisibleDelta = visibleAppendDelta(visible);
					if (appendedVisibleDelta !== null) {
						delta = appendedVisibleDelta;
						rememberVisible(visible);
						rememberRaw(raw);
					} else if (materializeVisible().startsWith(visible)) {
						continue;
					} else {
						delta = trimContinuationOverlap(materializeVisible(), visible);
						if (!delta) {
							if (visible.length > prevVisibleLength) {
								rememberVisible(visible);
								rememberRaw(raw);
							}
							continue;
						}
						appendVisibleDelta(delta);
						rememberRaw(raw);
					}
				}
			}
			if (!started) delta = delta.replace(/^\s+/, "");
			if (delta) {
				started = true;
				yield delta;
			}
		}
	};
	return { consumeLine };
}
