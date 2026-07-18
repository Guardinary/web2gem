import { throwIfAborted } from "../../shared/abort";
import { extractResponseFatalCode } from "./parse-parts";
import { createStreamTextExtractor } from "./parse-stream";
import { geminiSemanticError } from "./errors";

const RAW_DIAGNOSTIC_SAMPLE_CHARS = 500;

type GeminiWrbStreamEvent =
	| { type: "delta"; text: string }
	| { type: "summary"; rawSnippet: string; rawLength: number };

export async function* consumeGeminiWrbStream(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal | null | undefined,
): AsyncIterable<GeminiWrbStreamEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const extractor = createStreamTextExtractor();
	const lineChunks: string[] = [];
	let lineLength = 0;
	let rawSnippet = "";
	let rawLength = 0;

	const takeLine = (piece: string): string => {
		if (!lineChunks.length) return piece;
		if (piece) {
			lineChunks.push(piece);
			lineLength += piece.length;
		}
		const line = lineChunks.join("");
		lineChunks.length = 0;
		lineLength = 0;
		return line;
	};
	const appendLineRemainder = (piece: string): void => {
		if (!piece) return;
		lineChunks.push(piece);
		lineLength += piece.length;
	};
	const consumeLine = function* (
		line: string,
	): Generator<GeminiWrbStreamEvent> {
		const fatalCode = extractResponseFatalCode(line);
		if (fatalCode) throw geminiSemanticError("stream_generate", fatalCode);
		for (const text of extractor.consumeLine(line)) {
			if (text) yield { type: "delta", text };
		}
	};
	const consumeDecoded = function* (
		decoded: string,
	): Generator<GeminiWrbStreamEvent> {
		let lineStart = 0;
		let index = decoded.indexOf("\n", lineStart);
		while (index >= 0) {
			const line = takeLine(decoded.slice(lineStart, index));
			yield* consumeLine(line);
			lineStart = index + 1;
			index = decoded.indexOf("\n", lineStart);
		}
		if (lineStart < decoded.length)
			appendLineRemainder(decoded.slice(lineStart));
	};
	const rememberDecoded = (decoded: string): void => {
		rawLength += decoded.length;
		if (rawSnippet.length < RAW_DIAGNOSTIC_SAMPLE_CHARS) {
			rawSnippet += decoded.slice(
				0,
				RAW_DIAGNOSTIC_SAMPLE_CHARS - rawSnippet.length,
			);
		}
	};

	try {
		for (;;) {
			throwIfAborted(signal);
			const { done, value } = await reader.read();
			if (done) break;
			const decoded = decoder.decode(value, { stream: true });
			rememberDecoded(decoded);
			yield* consumeDecoded(decoded);
		}
		const tail = decoder.decode();
		if (tail) {
			rememberDecoded(tail);
			yield* consumeDecoded(tail);
		}
		if (lineLength > 0) yield* consumeLine(takeLine(""));
		yield { type: "summary", rawSnippet, rawLength };
	} finally {
		try {
			reader.releaseLock();
		} catch (_) {}
	}
}
