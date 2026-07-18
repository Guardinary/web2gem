import { describe, test } from "vitest";
import { socketHttp } from "../../../../src/gemini/transport/socket";
import { assert } from "../../assertions.js";
import { fakeSocketConnect, joinedWriteText } from "../../helpers.js";

async function gzipText(text) {
	const stream = new Blob([text])
		.stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe.sequential("socket response decompression", () => {
	test("decodes compressed socket HTTP responses when explicitly enabled", async () => {
		const body = await gzipText("hello");
		const state = {};
		const resp = await socketHttp(
			fakeSocketConnect(
				[
					`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${body.length}\r\n\r\n`,
					body,
				],
				state,
			),
			"https://example.test/compressed",
			{ acceptCompressed: true },
		);
		assert.equal(await resp.text(), "hello");
		assert.equal(resp.headers.get("content-encoding"), null);
		assert.equal(resp.headers.get("content-length"), null);
		assert.match(joinedWriteText(state), /Accept-Encoding: gzip\r\n/);
	});
});
