import { describe, test } from "vitest";
import { socketHttp } from "../../../../src/gemini/transport/socket";
import { assert } from "../../assertions.js";
import { fakeSocketConnect, joinedWriteText } from "./_support/socket.js";

describe.sequential("socketHttp", () => {
	test("sends socket HTTP requests with content length", async () => {
		const state: { closed?: boolean } = {};
		const resp = await socketHttp(
			fakeSocketConnect(
				["HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"],
				state,
			),
			"https://example.test/path?q=1",
			{
				method: "POST",
				headers: {
					"Accept-Encoding": "gzip",
					Connection: "keep-alive",
					"Content-Length": "999",
					Host: "evil.test",
					"X-Test": "yes",
				},
				body: "body",
			},
		);
		assert.equal(resp.status, 200);
		assert.equal(await resp.text(), "hello");
		assert.match(joinedWriteText(state), /POST \/path\?q=1 HTTP\/1\.1/);
		assert.match(joinedWriteText(state), /Host: example\.test/);
		assert.match(joinedWriteText(state), /Accept-Encoding: identity/);
		assert.match(joinedWriteText(state), /Connection: close/);
		assert.match(joinedWriteText(state), /Content-Length: 4/);
		assert.match(joinedWriteText(state), /X-Test: yes/);
		assert.doesNotMatch(joinedWriteText(state), /evil\.test/);
		assert.doesNotMatch(joinedWriteText(state), /Content-Length: 999/);
	});
	test("decodes chunked socket HTTP responses", async () => {
		const resp = await socketHttp(
			fakeSocketConnect([
				"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nhe",
				"ll\r\n1\r\no\r\n0\r\n\r\n",
			]),
			"https://example.test/chunked",
		);
		assert.equal(resp.status, 200);
		assert.equal(await resp.text(), "hello");

		const splitSize = await socketHttp(
			fakeSocketConnect([
				"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
				"5",
				"\r\nhello\r\n0\r\n\r\n",
			]),
			"https://example.test/split-chunk-size",
		);
		assert.equal(await splitSize.text(), "hello");

		const extension = await socketHttp(
			fakeSocketConnect([
				"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;foo=bar\r\nhello\r\n0;done\r\n\r\n",
			]),
			"https://example.test/chunk-extension",
		);
		assert.equal(await extension.text(), "hello");
	});
	test("handles socket responses with no body or close-delimited identity bodies", async () => {
		const noBody = await socketHttp(
			fakeSocketConnect([
				"HTTP/1.1 204 No Content\r\nContent-Length: 5\r\n\r\nhello",
			]),
			"https://example.test/no-body",
			{ method: "HEAD" },
		);
		assert.equal(noBody.status, 204);
		assert.equal(await noBody.text(), "");

		const identity = await socketHttp(
			fakeSocketConnect(["HTTP/1.1 200 OK\r\nX-Test: yes\r\n\r\nhe", "llo"]),
			"https://example.test/identity",
		);
		assert.equal(identity.status, 200);
		assert.equal(identity.headers.get("x-test"), "yes");
		assert.equal(await identity.text(), "hello");
	});
	test("skips interim 100 Continue socket responses", async () => {
		const resp = await socketHttp(
			fakeSocketConnect([
				"HTTP/1.1 100 Continue\r\n\r\n",
				"HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok",
			]),
			"https://example.test/continue",
		);
		assert.equal(resp.status, 201);
		assert.equal(await resp.text(), "ok");
	});
	test("rejects invalid socket Content-Length headers", async () => {
		await assert.rejects(
			() =>
				socketHttp(
					fakeSocketConnect([
						"HTTP/1.1 200 OK\r\nContent-Length: nope\r\n\r\n",
					]),
					"https://example.test/bad-length",
				),
			/invalid Content-Length/,
		);
	});
	test("rejects invalid socket chunk sizes and terminators", async () => {
		const invalidSize = await socketHttp(
			fakeSocketConnect([
				"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n",
			]),
			"https://example.test/bad-chunk-size",
		);
		await assert.rejects(() => invalidSize.text(), /invalid chunk size/);

		const invalidTerminator = await socketHttp(
			fakeSocketConnect([
				"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\naXX",
			]),
			"https://example.test/bad-chunk-terminator",
		);
		await assert.rejects(
			() => invalidTerminator.text(),
			/invalid chunk terminator/,
		);
	});
	test("rejects incomplete socket chunked bodies", async () => {
		const resp = await socketHttp(
			fakeSocketConnect([
				"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhe",
			]),
			"https://example.test/incomplete-chunked",
		);
		await assert.rejects(() => resp.text(), /incomplete chunked body/);

		const missingTerminator = await socketHttp(
			fakeSocketConnect([
				"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello",
			]),
			"https://example.test/incomplete-chunk-terminator",
		);
		await assert.rejects(
			() => missingTerminator.text(),
			/incomplete chunked body/,
		);
	});
	test("rejects incomplete fixed-length socket bodies", async () => {
		const resp = await socketHttp(
			fakeSocketConnect(["HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe"]),
			"https://example.test/incomplete-fixed",
		);
		await assert.rejects(() => resp.text(), /incomplete fixed-length body/);
	});
	test("rejects malformed socket response headers before exposing a body", async () => {
		await assert.rejects(
			() =>
				socketHttp(
					fakeSocketConnect(["HTTP/1.1 200 OK\r\nContent-Length: 1\r\n"]),
					"https://example.test/incomplete-headers",
				),
			/incomplete HTTP response headers/,
		);

		await assert.rejects(
			() =>
				socketHttp(
					fakeSocketConnect([
						`HTTP/1.1 200 OK\r\nX-Fill: ${"x".repeat(64 * 1024)}\r\n`,
					]),
					"https://example.test/huge-headers",
				),
			/HTTP response headers exceed/,
		);

		await assert.rejects(
			() =>
				socketHttp(
					fakeSocketConnect([
						"HTTP/1.1 200 OK\r\nContent-Length: 999999999999999999999\r\n\r\n",
					]),
					"https://example.test/huge-content-length",
				),
			/invalid Content-Length/,
		);
	});
	test("handles socket zero-length bodies trailers and body cancellation cleanup", async () => {
		const zero = await socketHttp(
			fakeSocketConnect([
				"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nignored",
			]),
			"https://example.test/zero",
		);
		assert.equal(await zero.text(), "");

		const trailer = await socketHttp(
			fakeSocketConnect([
				"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\nX-Trailer: yes\r\n\r\n",
			]),
			"https://example.test/trailer",
		);
		assert.equal(await trailer.text(), "hello");

		const state: { closed?: boolean } = {};
		const identity = await socketHttp(
			fakeSocketConnect(["HTTP/1.1 200 OK\r\n\r\nhello"], state),
			"https://example.test/cancel-body",
		);
		const reader = identity.body.getReader();
		const first = await reader.read();
		assert.equal(new TextDecoder().decode(first.value), "hello");
		await reader.cancel();
		assert.equal(state.closed, true);
	});
	test("closes sockets when request writes fail", async () => {
		const state = { closed: false };
		const connect = () => ({
			readable: new ReadableStream(),
			writable: new WritableStream({
				write() {
					throw new Error("write boom");
				},
			}),
			close() {
				state.closed = true;
			},
		});
		await assert.rejects(
			() =>
				socketHttp(connect, "https://example.test/write-failure", {
					body: "body",
				}),
			/write boom/,
		);
		assert.equal(state.closed, true);
	});
	test("rejects socket stream bodies without length before opening a socket", async () => {
		let connected = false;
		await assert.rejects(
			() =>
				socketHttp(
					() => {
						connected = true;
						return {
							readable: new ReadableStream(),
							writable: new WritableStream(),
							close() {},
						};
					},
					"https://example.test/missing-length",
					{
						method: "POST",
						body: new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode("x"));
								controller.close();
							},
						}),
					},
				),
			/streaming request body requires a known content length/,
		);
		assert.equal(connected, false);
	});
});
