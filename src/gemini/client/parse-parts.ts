import {
	extractTextsFromLine,
	innerPayloadFromEnvelope,
	iterateLines,
	parseWrbEnvelopes,
	wrbResponseShapeSummary,
} from "./parse-envelope";
import {
	extractCandidateResponse,
	type GeminiParsedImage,
} from "./parse-images";
import { getNested } from "./parse-values";

export type GeminiResponseParts = {
	text: string;
	images: GeminiParsedImage[];
	fatalCode?: string;
	candidateCount: number;
	generatedImageCount: number;
	webImageCount: number;
};

export type GeminiFatalCode = "1013" | "1037" | "1050" | "1052" | "1060";

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

export function hasArtifactMarkers(source: string): boolean {
	return (
		(source.indexOf("```") >= 0 && source.indexOf("code_event_index=") >= 0) ||
		source.indexOf("http://googleusercontent.com/") >= 0
	);
}

export function cleanText(text: unknown): string {
	return stripArtifacts(text).trim();
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
	let fatalCode: GeminiFatalCode | undefined;
	const envelopes = parseWrbEnvelopes(String(raw || ""));
	for (const envelope of envelopes) {
		fatalCode ||= fatalCodeFromEnvelope(envelope);
		const inner = innerPayloadFromEnvelope(envelope);
		if (inner) fatalCode ||= fatalCodeFromInner(inner);
	}
	const candidate = extractCandidateResponse(envelopes);
	const images = candidate.images;
	const generatedImageCount = images.filter(
		(image) => image.source === "generated",
	).length;
	const webImageCount = images.filter((image) => image.source === "web").length;
	const text =
		candidate.text === null
			? extractResponseText(raw)
			: cleanText(candidate.text);
	const out: GeminiResponseParts = {
		text,
		images,
		candidateCount: candidate.candidateCount,
		generatedImageCount,
		webImageCount,
	};
	if (fatalCode) out.fatalCode = fatalCode;
	return out;
}

export function extractResponseFatalCode(
	raw: unknown,
): GeminiFatalCode | undefined {
	const source = String(raw || "");
	for (const envelope of parseWrbEnvelopes(source)) {
		const envelopeCode = fatalCodeFromEnvelope(envelope);
		if (envelopeCode) return envelopeCode;
		const inner = innerPayloadFromEnvelope(envelope);
		if (!inner) continue;
		const innerCode = fatalCodeFromInner(inner);
		if (innerCode) return innerCode;
	}
	return undefined;
}

function fatalCodeFromInner(inner: unknown[]): GeminiFatalCode | undefined {
	return stableFatalCode(getNested(inner, [5, 2, 0, 1, 0]));
}

function fatalCodeFromEnvelope(
	envelope: unknown[],
): GeminiFatalCode | undefined {
	return stableFatalCode(getNested(envelope, [5, 2, 0, 1, 0]));
}

function stableFatalCode(code: unknown): GeminiFatalCode | undefined {
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
			return undefined;
	}
}

export type { GeminiParsedImage } from "./parse-images";
