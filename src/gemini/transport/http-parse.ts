import { TEXT_DECODER } from "../../shared/encoding";
import { _joinByteChunks } from "./byte-queue";
import type { ByteChunk, SocketTimeoutScope } from "./socket-types";

export const MAX_SOCKET_HEADER_BYTES = 64 * 1024;

export type ParsedSocketHeaderBlock = {
	httpVersion: string;
	status: number;
	headers: Headers;
};

type ReadSocketHeaderBlockOptions = {
	initial: ByteChunk;
	reader: ReadableStreamDefaultReader<ByteChunk>;
	timeout: SocketTimeoutScope;
	failBeforeBody: (message: unknown) => never;
};

export async function readSocketHeaderBlock({
	initial,
	reader,
	timeout,
	failBeforeBody,
}: ReadSocketHeaderBlockOptions): Promise<{
	headerBytes: ByteChunk;
	pending: ByteChunk;
}> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	let matched = 0;
	let headerEnd = -1;
	const pattern = [13, 10, 13, 10];
	const push = (value: ByteChunk | null | undefined) => {
		if (!value?.length || headerEnd >= 0) return;
		chunks.push(value);
		const base = total;
		for (let i = 0; i < value.length; i++) {
			const b = value[i];
			if (b === pattern[matched]) {
				matched += 1;
				if (matched === pattern.length) {
					headerEnd = base + i - pattern.length + 1;
					break;
				}
			} else {
				matched = b === pattern[0] ? 1 : 0;
			}
		}
		total += value.length;
	};
	push(initial);
	while (headerEnd < 0) {
		const { done, value } = await timeout.wait(
			reader.read(),
			"response headers",
		);
		if (done) break;
		push(value);
		if (headerEnd < 0 && total > MAX_SOCKET_HEADER_BYTES) {
			failBeforeBody(
				`socket: HTTP response headers exceed ${MAX_SOCKET_HEADER_BYTES} bytes`,
			);
		}
	}
	if (headerEnd < 0) failBeforeBody("socket: incomplete HTTP response headers");
	const joined = _joinByteChunks(chunks, total);
	return {
		headerBytes: joined.subarray(0, headerEnd),
		pending: joined.subarray(headerEnd + 4),
	};
}

export function parseHttpChunkSizeLine(line: ByteChunk): number {
	let start = 0;
	let end = line.length;
	while (start < end && isHttpWhitespace(line[start])) start += 1;
	while (end > start && isHttpWhitespace(line[end - 1])) end -= 1;

	let size = 0;
	let digits = 0;
	for (let i = start; i < end; i++) {
		const b = line[i];
		if (b === 59) break;
		const nibble = hexNibble(b);
		if (nibble < 0) return -1;
		digits += 1;
		size = size * 16 + nibble;
		if (!Number.isSafeInteger(size)) return -1;
	}
	return digits > 0 ? size : -1;
}

export function chunkSizeLineForError(line: ByteChunk): string {
	let start = 0;
	let end = line.length;
	while (start < end && isHttpWhitespace(line[start])) start += 1;
	while (end > start && isHttpWhitespace(line[end - 1])) end -= 1;
	const limit = Math.min(end, start + 80);
	let out = "";
	for (let i = start; i < limit; i++) {
		const b = line[i];
		if (b === 59) break;
		out +=
			b !== undefined && b >= 32 && b <= 126 ? String.fromCharCode(b) : "?";
	}
	return out;
}

export function parseSocketHeaderBlock(
	headerBytes: ByteChunk,
): ParsedSocketHeaderBlock {
	let lineStart = 0;
	let lineEnd = lineEndIndex(headerBytes, lineStart);
	if (lineEnd < 0) lineEnd = headerBytes.length;
	const statusLine = parseHttpStatusLine(headerBytes, lineStart, lineEnd);
	const headers = new Headers();
	lineStart = lineEnd + 2;

	while (lineStart <= headerBytes.length) {
		lineEnd = lineEndIndex(headerBytes, lineStart);
		if (lineEnd < 0) lineEnd = headerBytes.length;
		if (lineEnd <= lineStart) break;
		let colon = -1;
		for (let i = lineStart; i < lineEnd; i++) {
			if (headerBytes[i] === 58) {
				colon = i;
				break;
			}
		}
		if (colon > lineStart) {
			const nameStart = trimHttpHeaderStart(headerBytes, lineStart, colon);
			const nameEnd = trimHttpHeaderEnd(headerBytes, nameStart, colon);
			const valueStart = trimHttpHeaderStart(headerBytes, colon + 1, lineEnd);
			const valueEnd = trimHttpHeaderEnd(headerBytes, valueStart, lineEnd);
			try {
				headers.append(
					decodeHttpHeaderSlice(headerBytes, nameStart, nameEnd),
					decodeHttpHeaderSlice(headerBytes, valueStart, valueEnd),
				);
			} catch (_) {}
		}
		if (lineEnd === headerBytes.length) break;
		lineStart = lineEnd + 2;
	}

	return {
		httpVersion: statusLine.httpVersion,
		status: statusLine.status,
		headers,
	};
}

function isHttpWhitespace(value: number | undefined): boolean {
	return value === 32 || value === 9;
}

function hexNibble(value: number | undefined): number {
	if (value === undefined) return -1;
	if (value >= 48 && value <= 57) return value - 48;
	if (value >= 65 && value <= 70) return value - 55;
	if (value >= 97 && value <= 102) return value - 87;
	return -1;
}

function trimHttpHeaderStart(
	bytes: ByteChunk,
	start: number,
	end: number,
): number {
	let cursor = start;
	while (cursor < end && isHttpWhitespace(bytes[cursor])) cursor += 1;
	return cursor;
}

function trimHttpHeaderEnd(
	bytes: ByteChunk,
	start: number,
	end: number,
): number {
	let cursor = end;
	while (cursor > start && isHttpWhitespace(bytes[cursor - 1])) cursor -= 1;
	return cursor;
}

function decodeHttpHeaderSlice(
	bytes: ByteChunk,
	start: number,
	end: number,
): string {
	return start < end ? TEXT_DECODER.decode(bytes.subarray(start, end)) : "";
}

function lineEndIndex(bytes: ByteChunk, start: number): number {
	for (let i = start; i + 1 < bytes.length; i++) {
		if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
	}
	return -1;
}

function parseHttpStatusLine(
	bytes: ByteChunk,
	start: number,
	end: number,
): { httpVersion: string; status: number } {
	let versionEnd = start;
	while (versionEnd < end && !isHttpWhitespace(bytes[versionEnd]))
		versionEnd += 1;
	let codeStart = trimHttpHeaderStart(bytes, versionEnd, end);
	let status = 0;
	let digits = 0;
	while (codeStart < end) {
		const b = bytes[codeStart];
		if (b === undefined || b < 48 || b > 57) break;
		status = status * 10 + (b - 48);
		digits += 1;
		codeStart += 1;
	}
	return {
		httpVersion: decodeHttpHeaderSlice(bytes, start, versionEnd),
		status: digits > 0 ? status : 0,
	};
}
