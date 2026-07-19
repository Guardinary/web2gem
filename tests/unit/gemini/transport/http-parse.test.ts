// @ts-nocheck
import { describe, test } from "vitest";
import { createByteQueue } from "../../../../src/gemini/transport/byte-queue";
import { parseHttpChunkSizeLine } from "../../../../src/gemini/transport/http-parse";
import { assert } from "../../assertions.js";

describe("HTTP response parsing", () => {
	test("parses standalone HTTP chunk-size lines", () => {
		const encoder = new TextEncoder();
		assert.equal(parseHttpChunkSizeLine(encoder.encode(" a;ext=1 ")), 10);
		assert.equal(parseHttpChunkSizeLine(encoder.encode("0;done")), 0);
		assert.equal(parseHttpChunkSizeLine(encoder.encode("a ;ext=1")), -1);
		assert.equal(parseHttpChunkSizeLine(encoder.encode("Z")), -1);
	});

	test("parses streamed HTTP chunk-size lines incrementally", () => {
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		const chunkSizeQueue = createByteQueue(encoder.encode(" a;"));
		chunkSizeQueue.push(encoder.encode(["ext=1", "\r\n", "body"].join("")));
		assert.deepEqual(chunkSizeQueue.readHttpChunkSizeLineIfAvailable(), {
			size: 10,
			errorLine: "a",
		});
		assert.equal(decoder.decode(chunkSizeQueue.read(4)), "body");

		const byteSplitChunkSize = createByteQueue();
		for (const byte of encoder.encode(`1;${"x".repeat(4096)}\r\nbody`)) {
			byteSplitChunkSize.push(new Uint8Array([byte]));
		}
		assert.deepEqual(byteSplitChunkSize.readHttpChunkSizeLineIfAvailable(), {
			size: 1,
			errorLine: "1",
		});
		assert.equal(decoder.decode(byteSplitChunkSize.read(4)), "body");

		const invalidChunkSize = createByteQueue(encoder.encode("a "));
		invalidChunkSize.push(encoder.encode(";ext=1\r\n"));
		assert.deepEqual(invalidChunkSize.readHttpChunkSizeLineIfAvailable(), {
			size: -1,
			errorLine: "a",
		});
	});
});
