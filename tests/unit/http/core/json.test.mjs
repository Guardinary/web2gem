import { describe, test } from "vitest";
import { readJsonRequest } from "../../../../src/http/core/json";
import { assert } from "../../assertions.js";

function concatBytes(...parts) {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

describe("readJsonRequest", () => {
	test("reads object JSON through standard and native byte paths", async () => {
		const valid = await readJsonRequest(
			new Request("https://worker.example/", {
				method: "POST",
				body: JSON.stringify({ ok: true }),
			}),
		);
		assert.deepEqual(valid.value, { ok: true });
		assert.equal(valid.bytes > 0, true);

		let nativeBytesCalled = false;
		const nativeBytesRequest = new Request("https://worker.example/", {
			method: "POST",
			body: "{}",
		});
		Object.defineProperty(nativeBytesRequest, "bytes", {
			configurable: true,
			value: async () => {
				nativeBytesCalled = true;
				return new TextEncoder().encode('{"ok":"bytes"}');
			},
		});
		Object.defineProperty(nativeBytesRequest, "arrayBuffer", {
			configurable: true,
			value: async () => {
				throw new Error("arrayBuffer should not be used");
			},
		});
		const nativeBytes = await readJsonRequest(nativeBytesRequest);
		assert.deepEqual(nativeBytes.value, { ok: "bytes" });
		assert.equal(nativeBytesCalled, true);
	});

	test("honors declared lengths and cancels oversized streams", async () => {
		const declaredLarge = await readJsonRequest(
			new Request("https://worker.example/", {
				method: "POST",
				headers: { "Content-Length": "1000" },
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array([123, 125]));
						controller.close();
					},
				}),
				duplex: "half",
			}),
			{
				maxBodyBytes: 1000,
			},
		);
		assert.deepEqual(declaredLarge.value, {});

		let declaredSmallCanceled = false;
		let declaredSmallPulls = 0;
		const declaredSmallActualLarge = await readJsonRequest(
			new Request("https://worker.example/", {
				method: "POST",
				headers: { "Content-Length": "1" },
				body: new ReadableStream({
					pull(controller) {
						declaredSmallPulls += 1;
						controller.enqueue(
							new TextEncoder().encode(
								declaredSmallPulls === 1 ? '{"a":"123"' : "}",
							),
						);
					},
					cancel() {
						declaredSmallCanceled = true;
					},
				}),
				duplex: "half",
			}),
			{
				maxBodyBytes: 10,
			},
		);
		assert.equal(declaredSmallActualLarge.status, 413);
		assert.match(declaredSmallActualLarge.error, /11 bytes > 10/);
		assert.equal(declaredSmallPulls, 2);
		assert.equal(declaredSmallCanceled, true);

		let canceled = false;
		const oversized = await readJsonRequest(
			new Request("https://worker.example/", {
				method: "POST",
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"a"'));
						controller.enqueue(new TextEncoder().encode(":1}"));
					},
					cancel() {
						canceled = true;
					},
				}),
				duplex: "half",
			}),
			{
				maxBodyBytes: 3,
				oversizedError: {
					message: "too large for test",
					status: 413,
					code: "too_large",
				},
			},
		);
		assert.equal(oversized.status, 413);
		assert.equal(oversized.code, "too_large");
		assert.equal(canceled, true);
	});

	test("maps request body stream failures", async () => {
		const failedRead = await readJsonRequest(
			new Request("https://worker.example/", {
				method: "POST",
				body: new ReadableStream({
					pull() {
						throw new Error("stream broke");
					},
				}),
				duplex: "half",
			}),
		);
		assert.equal(failedRead.status, 400);
		assert.match(failedRead.error, /failed to read request body: stream broke/);
	});

	test("rejects invalid UTF-8 malformed JSON and non-object bodies", async () => {
		const invalidUtf8 = await readJsonRequest(
			new Request("https://worker.example/", {
				method: "POST",
				body: new Uint8Array([0xff]),
			}),
		);
		assert.equal(invalidUtf8.error, "invalid UTF-8 request body");

		const invalidUtf8String = await readJsonRequest(
			new Request("https://worker.example/", {
				method: "POST",
				body: concatBytes(
					new TextEncoder().encode('{"x":"'),
					new Uint8Array([0xff]),
					new TextEncoder().encode('"}'),
				),
			}),
		);
		assert.equal(invalidUtf8String.error, "invalid UTF-8 request body");

		const invalidJson = await readJsonRequest(
			new Request("https://worker.example/", {
				method: "POST",
				body: "{",
			}),
		);
		assert.equal(invalidJson.error, "invalid JSON");

		const nonObject = await readJsonRequest(
			new Request("https://worker.example/", {
				method: "POST",
				body: "[]",
			}),
		);
		assert.equal(nonObject.error, "request body must be a JSON object");
	});
});
