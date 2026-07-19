import { describe, test } from "vitest";
import { buildMultipartFileBody } from "../../../../src/gemini/uploads/multipart";
import { assert } from "../../assertions.js";
import { withPatchedGlobal } from "../../_support/globals.js";
import { bodyBytes } from "./_support/upload-fixtures.js";

function escapeRegExp(value: unknown) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertMultipartText(
	multipart: ReturnType<typeof buildMultipartFileBody>,
	bytes: Uint8Array,
	expectedText: string,
) {
	const text = new TextDecoder().decode(bytes);
	assert.equal(bytes.byteLength, multipart.contentLength);
	assert.equal(
		multipart.contentType,
		`multipart/form-data; boundary=${multipart.boundary}`,
	);
	assert.match(text, new RegExp(`--${escapeRegExp(multipart.boundary)}`));
	assert.match(text, /name="file"; filename="bad_name\.txt"/);
	assert.match(text, /Content-Type: text\/plain/);
	assert.match(text, new RegExp(`\\r\\n\\r\\n${expectedText}\\r\\n`));
	assert.match(
		text,
		new RegExp(`--${escapeRegExp(multipart.boundary)}--\\r\\n$`),
	);
}

describe("multipart upload bodies", () => {
	test("writes exact bytes through FixedLengthStream", async () => {
		const lengths: number[] = [];
		class FakeFixedLengthStream {
			readonly readable: ReadableStream<Uint8Array>;
			readonly writable: WritableStream<Uint8Array>;

			constructor(length: number) {
				lengths.push(length);
				const stream = new TransformStream<Uint8Array, Uint8Array>();
				this.readable = stream.readable;
				this.writable = stream.writable;
			}
		}

		await withPatchedGlobal(
			"FixedLengthStream",
			FakeFixedLengthStream,
			async () => {
				const multipart = buildMultipartFileBody({
					bytes: new Uint8Array([65, 66, 67]),
					mime: " text/plain\r\n ",
					filename: 'bad"name.txt',
				});
				const bytes = await bodyBytes(multipart.body);
				assert.deepEqual(lengths, [multipart.contentLength]);
				assertMultipartText(multipart, bytes, "ABC");
			},
		);
	});

	test("uses a readable stream fallback with the same content length", async () => {
		await withPatchedGlobal("FixedLengthStream", undefined, async () => {
			const multipart = buildMultipartFileBody({
				bytes: new Uint8Array([88, 89, 90]),
				mime: "text/plain",
				filename: 'bad"name.txt',
			});
			const bytes = await bodyBytes(multipart.body);
			assertMultipartText(multipart, bytes, "XYZ");
		});
	});
});
