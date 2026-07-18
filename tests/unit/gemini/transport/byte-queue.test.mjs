import { describe, test } from "vitest";
import {
	_joinByteChunks,
	bytesFromBody,
	createByteQueue,
} from "../../../../src/gemini/transport/byte-queue";
import { assert } from "../../assertions.js";

describe("byte queue", () => {
	test("joins byte chunks", () => {
		const encoder = new TextEncoder();
		assert.equal(
			new TextDecoder().decode(
				_joinByteChunks([encoder.encode("ab"), encoder.encode("cd")], 4),
			),
			"abcd",
		);
	});

	test("normalizes supported request body values", () => {
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		assert.equal(decoder.decode(bytesFromBody("hello")), "hello");
		assert.equal(
			decoder.decode(bytesFromBody(encoder.encode("view").buffer)),
			"view",
		);
		assert.equal(bytesFromBody(null), null);
		assert.equal(bytesFromBody(3).length, 3);
		assert.deepEqual(
			Array.from(bytesFromBody(new Uint8Array([1, 2, 3]).buffer)),
			[1, 2, 3],
		);
		const bytes = new Uint8Array([4, 5, 6, 7]);
		assert.deepEqual(
			Array.from(bytesFromBody(new DataView(bytes.buffer, 1, 2))),
			[5, 6],
		);
	});

	test("reads queued bytes and split CRLF lines", () => {
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		const queue = createByteQueue(encoder.encode("one\r\n"));
		queue.push(encoder.encode("two\r\ntail"));
		assert.equal(decoder.decode(queue.readLine()), "one");
		assert.equal(decoder.decode(queue.readLineIfAvailable()), "two");
		assert.equal(decoder.decode(queue.read(4)), "tail");
		assert.equal(queue.length, 0);

		const splitQueue = createByteQueue(encoder.encode("ab"));
		splitQueue.push(encoder.encode("cd\r"));
		assert.equal(splitQueue.readLineIfAvailable(), null);
		splitQueue.push(encoder.encode("\nrest"));
		assert.equal(decoder.decode(splitQueue.readLineIfAvailable()), "abcd");
		assert.equal(decoder.decode(splitQueue.read(4)), "rest");
	});
});
