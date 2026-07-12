import { TEXT_ENCODER } from "../../shared/encoding";
import type { ByteChunk, ByteQueue } from "./socket-types";

export function _joinByteChunks(
	chunks: readonly ByteChunk[] | null | undefined,
	totalLength: number,
): ByteChunk {
	if (!chunks?.length) return new Uint8Array(0);
	if (chunks.length === 1) return chunks[0] || new Uint8Array(0);
	const out = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

export function bytesFromBody(body: unknown): ByteChunk | null {
	if (body == null) return null;
	if (typeof body === "string") return TEXT_ENCODER.encode(body);
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body))
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	return new Uint8Array(body as ArrayBufferLike);
}

export function createByteQueue(initial?: ByteChunk | null): ByteQueue {
	const chunks: ByteChunk[] = [];
	let headIndex = 0;
	let headOffset = 0;
	let length = 0;
	let scanActive = false;
	let scanChunkIndex = 0;
	let scanOffset = 0;
	let scanBytes = 0;
	let scanPrev = -1;
	let scanMode: "line" | "http-chunk-size" | null = null;
	let scanHttpSize = 0;
	let scanHttpDigits = 0;
	let scanHttpInvalid = false;
	let scanHttpAfterDigitWhitespace = false;
	let scanHttpInExtension = false;
	let scanHttpErrorLine = "";
	if (initial?.length) {
		chunks.push(initial);
		length = initial.length;
	}
	const resetScan = () => {
		scanActive = false;
		scanChunkIndex = headIndex;
		scanOffset = headOffset;
		scanBytes = 0;
		scanPrev = -1;
		scanMode = null;
		scanHttpSize = 0;
		scanHttpDigits = 0;
		scanHttpInvalid = false;
		scanHttpAfterDigitWhitespace = false;
		scanHttpInExtension = false;
		scanHttpErrorLine = "";
	};
	const ensureScan = (mode: "line" | "http-chunk-size") => {
		if (
			scanActive &&
			scanMode === mode &&
			scanChunkIndex >= headIndex &&
			(scanChunkIndex !== headIndex || scanOffset >= headOffset)
		)
			return;
		scanActive = true;
		scanChunkIndex = headIndex;
		scanOffset = headOffset;
		scanBytes = 0;
		scanPrev = -1;
		scanMode = mode;
		scanHttpSize = 0;
		scanHttpDigits = 0;
		scanHttpInvalid = false;
		scanHttpAfterDigitWhitespace = false;
		scanHttpInExtension = false;
		scanHttpErrorLine = "";
	};
	const compact = () => {
		while (headIndex < chunks.length) {
			const first = chunks[headIndex];
			if (!first || headOffset < first.length) break;
			headOffset -= first.length;
			headIndex += 1;
		}
		if (headIndex >= chunks.length) {
			chunks.length = 0;
			headIndex = 0;
			headOffset = 0;
			resetScan();
		} else if (headIndex > 32 && headIndex * 2 >= chunks.length) {
			chunks.splice(0, headIndex);
			if (scanActive) scanChunkIndex = Math.max(0, scanChunkIndex - headIndex);
			headIndex = 0;
		}
	};
	const readByte = (): number => {
		compact();
		if (headIndex >= chunks.length) return -1;
		const first = chunks[headIndex];
		if (!first) return -1;
		const value = first[headOffset];
		if (value === undefined) return -1;
		headOffset += 1;
		length -= 1;
		compact();
		resetScan();
		return value;
	};
	const consumeLine = (
		lineLength: number,
		consumeLength: number,
	): ByteChunk => {
		compact();
		const out = lineLength > 0 ? new Uint8Array(lineLength) : new Uint8Array(0);
		let copied = 0;
		let remaining = consumeLength;
		while (remaining > 0) {
			compact();
			const first = chunks[headIndex];
			if (!first) break;
			const take = Math.min(remaining, first.length - headOffset);
			const copy = Math.min(take, lineLength - copied);
			if (copy > 0) {
				out.set(first.subarray(headOffset, headOffset + copy), copied);
				copied += copy;
			}
			headOffset += take;
			length -= take;
			remaining -= take;
		}
		compact();
		resetScan();
		return out;
	};
	const consumeBytes = (consumeLength: number) => {
		compact();
		let remaining = consumeLength;
		while (remaining > 0) {
			const first = chunks[headIndex];
			if (!first) break;
			const take = Math.min(remaining, first.length - headOffset);
			headOffset += take;
			length -= take;
			remaining -= take;
			if (headOffset >= first.length) {
				headIndex += 1;
				headOffset = 0;
			}
		}
		compact();
		resetScan();
	};
	const scanHttpChunkSizeByte = (b: number) => {
		if (scanHttpInExtension) return;
		if (b === 59) {
			if (scanHttpDigits <= 0 || scanHttpAfterDigitWhitespace)
				scanHttpInvalid = true;
			scanHttpInExtension = true;
			return;
		}
		if (scanHttpErrorLine.length < 80)
			scanHttpErrorLine += b >= 32 && b <= 126 ? String.fromCharCode(b) : "?";
		if (isHttpWhitespaceByte(b)) {
			if (scanHttpDigits > 0) scanHttpAfterDigitWhitespace = true;
			return;
		}
		if (scanHttpAfterDigitWhitespace) {
			scanHttpInvalid = true;
			return;
		}
		const nibble = hexNibbleByte(b);
		if (nibble < 0) {
			scanHttpInvalid = true;
			return;
		}
		scanHttpDigits += 1;
		scanHttpSize = scanHttpSize * 16 + nibble;
		if (!Number.isSafeInteger(scanHttpSize)) scanHttpInvalid = true;
	};
	const api: ByteQueue = {
		get length() {
			return length;
		},
		push(chunk: ByteChunk | null | undefined) {
			if (!chunk?.length) return;
			chunks.push(chunk);
			length += chunk.length;
		},
		read(n: unknown) {
			const count = Math.max(0, Math.min(Number(n) || 0, length));
			if (!count) return new Uint8Array(0);
			compact();
			const first = chunks[headIndex];
			if (first) {
				const available = first.length - headOffset;
				if (count <= available) {
					const out = first.subarray(headOffset, headOffset + count);
					headOffset += count;
					length -= count;
					compact();
					resetScan();
					return out;
				}
			}
			const out = new Uint8Array(count);
			let offset = 0;
			while (offset < count) {
				compact();
				const nextChunk = chunks[headIndex];
				if (!nextChunk) break;
				const take = Math.min(count - offset, nextChunk.length - headOffset);
				out.set(nextChunk.subarray(headOffset, headOffset + take), offset);
				headOffset += take;
				offset += take;
				length -= take;
			}
			compact();
			resetScan();
			return out;
		},
		readLine() {
			const out: number[] = [];
			for (;;) {
				const b = readByte();
				if (b < 0) return null;
				if (b === 13) {
					const next = readByte();
					if (next === 10) return new Uint8Array(out);
					out.push(b);
					if (next >= 0) out.push(next);
					continue;
				}
				out.push(b);
			}
		},
		readLineIfAvailable() {
			compact();
			ensureScan("line");
			for (let c = scanChunkIndex; c < chunks.length; c++) {
				const chunk = chunks[c];
				if (!chunk) continue;
				let start = 0;
				if (c === scanChunkIndex) start = scanOffset;
				else if (c === headIndex) start = headOffset;
				for (let i = start; i < chunk.length; i++) {
					const b = chunk[i];
					if (b === undefined) continue;
					if (scanPrev === 13 && b === 10) {
						return consumeLine(scanBytes - 1, scanBytes + 1);
					}
					scanPrev = b;
					scanBytes += 1;
					scanChunkIndex = c;
					scanOffset = i + 1;
				}
				scanChunkIndex = c + 1;
				scanOffset = 0;
			}
			return null;
		},
		readHttpChunkSizeLineIfAvailable() {
			compact();
			ensureScan("http-chunk-size");
			for (let c = scanChunkIndex; c < chunks.length; c++) {
				const chunk = chunks[c];
				if (!chunk) continue;
				let start = 0;
				if (c === scanChunkIndex) start = scanOffset;
				else if (c === headIndex) start = headOffset;
				for (let i = start; i < chunk.length; i++) {
					const b = chunk[i];
					if (b === undefined) continue;
					if (scanPrev === 13 && b === 10) {
						const result = {
							size: scanHttpInvalid || scanHttpDigits <= 0 ? -1 : scanHttpSize,
							errorLine: trimHttpChunkSizeErrorLine(scanHttpErrorLine),
						};
						consumeBytes(scanBytes + 1);
						return result;
					}
					if (scanPrev >= 0 && !scanHttpInExtension)
						scanHttpChunkSizeByte(scanPrev);
					scanPrev = b;
					scanBytes += 1;
					scanChunkIndex = c;
					scanOffset = i + 1;
				}
				scanChunkIndex = c + 1;
				scanOffset = 0;
			}
			return null;
		},
		skipCRLF() {
			const a = readByte();
			const b = readByte();
			return a === 13 && b === 10;
		},
		drain(controller: ReadableStreamDefaultController<ByteChunk>) {
			compact();
			if (!length) return;
			while (headIndex < chunks.length) {
				const first = chunks[headIndex];
				if (!first) break;
				const out = headOffset ? first.subarray(headOffset) : first;
				if (out.length) controller.enqueue(out);
				headIndex += 1;
				headOffset = 0;
			}
			chunks.length = 0;
			headIndex = 0;
			length = 0;
			resetScan();
		},
	};
	return api;
}

function isHttpWhitespaceByte(value: number | undefined): boolean {
	return value === 32 || value === 9;
}

function hexNibbleByte(value: number | undefined): number {
	if (value === undefined) return -1;
	if (value >= 48 && value <= 57) return value - 48;
	if (value >= 65 && value <= 70) return value - 55;
	if (value >= 97 && value <= 102) return value - 87;
	return -1;
}

function trimHttpChunkSizeErrorLine(value: string): string {
	const semi = value.indexOf(";");
	return (semi >= 0 ? value.slice(0, semi) : value).trim();
}
