import {
	createRuntimeConfig,
	getConfig,
	type RuntimeConfig,
} from "../../../../src/config";

export function baseGeminiClientConfig(
	overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
	return {
		...createRuntimeConfig(getConfig()),
		gemini_origin: "https://gemini.example",
		gemini_bl: "boq_test",
		cookie: "",
		sapisid: "",
		request_timeout_sec: 180,
		retry_attempts: 1,
		retry_delay_sec: 0,
		current_input_file_min_bytes: 1000000,
		upstream_socket: false,
		log_requests: false,
		...overrides,
	};
}

function wrbLine(candidates: readonly unknown[]): string {
	const inner = [null, null, null, null, candidates, "x".repeat(160)];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

export function wrbCandidatesLine(candidates: readonly unknown[]): string {
	return wrbLine(candidates);
}

export function wrbTextLine(texts: readonly string[]): string {
	return wrbLine([[null, texts]]);
}

export function wrbCandidateLine(candidate: unknown[]): string {
	return wrbCandidatesLine([candidate]);
}

type FatalWrbLocation = "inner" | "envelope";

export function fatalWrbLine(
	code: number,
	location: FatalWrbLocation = "inner",
): string {
	const inner: unknown[] = [null, null, null, null, []];
	const envelope: unknown[] = ["wrb.fr", null, JSON.stringify(inner)];
	const target = location === "envelope" ? envelope : inner;
	const codeEntry: unknown[] = [];
	codeEntry[1] = [code];
	const fatalParts: unknown[] = [];
	fatalParts[2] = [codeEntry];
	target[5] = fatalParts;
	if (location === "inner") envelope[2] = JSON.stringify(inner);
	return JSON.stringify([envelope]);
}

export function generatedImageEntry(
	url = "https://lh3.googleusercontent.com/generated=s1024-rj",
	id = "img_1",
): unknown[] {
	const detail: unknown[] = [];
	detail[2] = "generated alt";
	detail[3] = url;
	const meta: unknown[] = [];
	meta[3] = detail;
	return [meta, [id]];
}

export function generatedImageCandidate(
	text = "final text",
	url = "https://lh3.googleusercontent.com/generated=s1024-rj",
): unknown[] {
	const candidate: unknown[] = [];
	candidate[1] = [text];
	candidate[8] = [2];
	const rich: unknown[] = [];
	rich[7] = [[generatedImageEntry(url)]];
	candidate[12] = rich;
	return candidate;
}
