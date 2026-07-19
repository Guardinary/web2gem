// @ts-nocheck
import { describe, test } from "vitest";
import { materializeAttachment } from "../../../src/attachments/materialize";
import { assert } from "../assertions.js";

const generousLimits = { maxFileBytes: 1024, maxImageBytes: 1024 };

function attachmentCandidate(kind, source, overrides = {}) {
	return {
		id: "att_1",
		kind,
		role: "request",
		source,
		...overrides,
	};
}

async function captureError(run) {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected operation to fail");
}

describe("attachment materialization", () => {
	test("preserves byte sources and explicit media metadata", async () => {
		const bytes = new Uint8Array([65, 66, 67]);
		const candidate = attachmentCandidate(
			"file",
			{ type: "bytes", bytes },
			{
				filename: "source.txt",
				mime: "text/custom",
			},
		);
		const result = await materializeAttachment(candidate, generousLimits);
		assert.equal(result.candidate, candidate);
		assert.equal(result.bytes, bytes);
		assert.equal(result.mime, "text/custom");
		assert.equal(result.filename, "source.txt");
	});

	test("decodes base64 and infers MIME and filename from bytes", async () => {
		const result = await materializeAttachment(
			attachmentCandidate("file", {
				type: "base64",
				data: "JVBERi0xLjQK",
			}),
			generousLimits,
		);
		assert.equal(new TextDecoder().decode(result.bytes), "%PDF-1.4\n");
		assert.equal(result.mime, "application/pdf");
		assert.equal(result.filename, "file-1.pdf");

		const image = await materializeAttachment(
			attachmentCandidate("image", { type: "base64", data: "AA==" }),
			generousLimits,
		);
		assert.equal(image.mime, "application/octet-stream");
		assert.equal(image.filename, "image.png");
	});

	test("reports invalid base64 with attachment metadata and cause", async () => {
		const error = await captureError(() =>
			materializeAttachment(
				attachmentCandidate("file", { type: "base64", data: "not base64!?" }),
				generousLimits,
			),
		);
		assert.equal(error.code, "invalid_base64");
		assert.equal(error.status, 400);
		assert.equal(error.attachmentKind, "file");
		assert.match(error.message, /invalid base64 payload/);
		assert.equal(error.cause instanceof Error, true);
	});

	test("enforces file and image byte limits before decoding", async () => {
		const original = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
		let decoderCalled = false;
		Object.defineProperty(Uint8Array, "fromBase64", {
			value() {
				decoderCalled = true;
				throw new Error("decoder must not run");
			},
			configurable: true,
			writable: true,
		});
		try {
			const fileError = await captureError(() =>
				materializeAttachment(
					attachmentCandidate("file", { type: "base64", data: "AAAA" }),
					{ maxFileBytes: 2, maxImageBytes: 10 },
				),
			);
			assert.equal(fileError.code, "file_too_large");
			assert.equal(fileError.status, 413);
			assert.equal(fileError.attachmentKind, "file");
			assert.equal(decoderCalled, false);

			const imageError = await captureError(() =>
				materializeAttachment(
					attachmentCandidate("image", {
						type: "bytes",
						bytes: new Uint8Array([1, 2, 3]),
					}),
					{ maxFileBytes: 10, maxImageBytes: 2 },
				),
			);
			assert.equal(imageError.code, "image_too_large");
			assert.equal(imageError.status, 413);
			assert.equal(imageError.attachmentKind, "image");
		} finally {
			if (original) Object.defineProperty(Uint8Array, "fromBase64", original);
			else delete Uint8Array.fromBase64;
		}
	});
});
