// @ts-nocheck
import { describe, test } from "vitest";
import {
	chooseUploadMime,
	cleanUploadMime,
	detectUploadMimeFromBytes,
	filenameFromUrl,
	genericFilenameFromMime,
	imageFilenameFromMime,
	mimeFromFilename,
	normalizeMimeType,
	sanitizeUploadFilename,
} from "../../../src/attachments/mime";
import { assert } from "../assertions.js";

const encoder = new TextEncoder();

describe("attachment MIME and filenames", () => {
	test("sanitizes upload filenames and URL path segments", () => {
		assert.equal(
			sanitizeUploadFilename("../bad\u0000\r\nname.png"),
			"bad  name.png",
		);
		assert.equal(sanitizeUploadFilename(".."), "");
		assert.equal(sanitizeUploadFilename("x".repeat(220)).length, 180);
		assert.equal(
			filenameFromUrl("https://example.com/a%20b.png?x=1"),
			"a b.png",
		);
		assert.equal(filenameFromUrl("https://example.com/%E0%A4%A"), "%E0%A4%A");
	});

	test("maps known MIME types and filename extensions", () => {
		assert.equal(imageFilenameFromMime("image/jpeg", 1), "image.jpg");
		assert.equal(imageFilenameFromMime("image/webp", 2), "image-2.webp");
		assert.equal(imageFilenameFromMime("image/gif", 3), "image-3.gif");
		assert.equal(imageFilenameFromMime("image/bmp", 4), "image-4.bmp");
		assert.equal(imageFilenameFromMime("image/heic", 5), "image-5.heic");
		assert.equal(imageFilenameFromMime("image/heif", 6), "image-6.heif");
		assert.equal(
			imageFilenameFromMime("application/octet-stream", 7),
			"image-7.png",
		);
		assert.equal(
			genericFilenameFromMime("application/octet-stream", 7),
			"file-7.bin",
		);
		assert.equal(genericFilenameFromMime("text/x-python", 2), "file-2.py");
		assert.equal(genericFilenameFromMime("text/custom", 3), "file-3.txt");
		assert.equal(mimeFromFilename("main.py"), "text/x-python");
		assert.equal(mimeFromFilename("README.unknown"), "");
	});

	test("cleans chooses and normalizes MIME values", () => {
		assert.equal(cleanUploadMime(" text/plain\r\n "), "text/plain");
		assert.equal(cleanUploadMime(null), "");
		assert.equal(chooseUploadMime("", " image/png "), "image/png");
		assert.equal(chooseUploadMime(null, ""), "application/octet-stream");
		assert.equal(
			normalizeMimeType(" Text/Plain; charset=utf-8 "),
			"text/plain",
		);
	});

	test("detects supported media signatures and conservative text fallbacks", () => {
		const cases = [
			[
				new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
				"image/png",
			],
			[new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"],
			[encoder.encode("GIF89a"), "image/gif"],
			[encoder.encode("RIFF1234WEBP"), "image/webp"],
			[encoder.encode("%PDF-1.7"), "application/pdf"],
			[new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "application/zip"],
			[encoder.encode('  {"ok":true}'), "application/json"],
			[encoder.encode("plain text"), "text/plain"],
			[new Uint8Array([0, 1, 2]), ""],
			[new Uint8Array(), ""],
		];
		for (const [bytes, expected] of cases) {
			assert.equal(detectUploadMimeFromBytes(bytes), expected);
		}
	});
});
