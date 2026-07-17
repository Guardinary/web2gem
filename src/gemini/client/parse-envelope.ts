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

export type WrbEnvelope = unknown[];

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

export function extractWrbInnerPayloads(raw: unknown): unknown[][] {
	const out: unknown[][] = [];
	for (const envelope of parseWrbEnvelopes(String(raw || ""))) {
		const inner = innerPayloadFromEnvelope(envelope);
		if (inner) out.push(inner);
	}
	return out;
}

export function parseWrbEnvelopes(source: string): unknown[][] {
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

export function innerPayloadFromEnvelope(
	envelope: unknown[],
): unknown[] | null {
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

export function* iterateLines(source: string): Generator<string> {
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
