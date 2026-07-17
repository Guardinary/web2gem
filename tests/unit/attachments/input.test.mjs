import { describe, test } from "vitest";
import {
	isDataUrl,
	normalizeUploadFileInput,
	parseDataUrl,
	parseImageUrl,
	parseUploadUrl,
	uploadFilenameFromObject,
	uploadMimeFromObject,
} from "../../../src/attachments/input";
import { assert } from "../assertions.js";

describe("attachment input", () => {
	test("parses base64 and percent-encoded data URLs only", () => {
		assert.deepEqual(parseDataUrl("data:text/plain;base64,QQ=="), {
			b64: "QQ==",
			mime: "text/plain",
		});
		assert.deepEqual(parseUploadUrl("data:text/plain,hello%20world"), {
			b64: "aGVsbG8gd29ybGQ=",
			mime: "text/plain",
		});
		assert.equal(parseDataUrl("data:text/plain,%E0%A4%A"), null);
		assert.equal(parseUploadUrl("https://files.example/a.txt"), null);
		assert.equal(parseUploadUrl("data:text/plain"), null);
		assert.equal(isDataUrl("  DATA:text/plain,ok"), true);
		assert.equal(isDataUrl("https://files.example/a.txt"), false);
	});

	test("normalizes image data URLs with explicit MIME precedence", () => {
		assert.deepEqual(
			parseImageUrl("data:IMAGE/PNG;charset=utf-8;base64,AAAA"),
			{ b64: "AAAA", mime: "image/png" },
		);
		assert.deepEqual(parseImageUrl("data:;base64,AAAA", "image/webp"), {
			b64: "AAAA",
			mime: "image/webp",
		});
		assert.deepEqual(parseImageUrl("data:;base64,AAAA"), {
			b64: "AAAA",
			mime: "image/png",
		});
		assert.equal(parseImageUrl("https://example.com/a.png"), null);
		assert.equal(parseImageUrl("ftp://example.com/a.png"), null);
	});

	test("reads filename and MIME aliases from nested attachment objects", () => {
		const nested = {
			inline_data: {
				display_name: " ../inline.gif ",
				mime_type: "image/gif",
			},
		};
		assert.equal(uploadFilenameFromObject(nested), "inline.gif");
		assert.equal(uploadMimeFromObject(nested), "image/gif");
		assert.deepEqual(
			normalizeUploadFileInput({
				type: "input_file",
				filename: "document.txt",
				file_data: "data:application/pdf;base64,JVBERi0=",
			}),
			{ b64: "JVBERi0=", mime: "application/pdf", filename: "document.txt" },
		);
		assert.deepEqual(
			normalizeUploadFileInput({
				type: "input_file",
				filename: "../nested.py",
				file_data: { data: "cHJpbnQoMikK", mime_type: "text/x-python" },
				data: "dG9wLWxldmVs",
			}),
			{ b64: "cHJpbnQoMikK", mime: "text/x-python", filename: "nested.py" },
		);
	});

	test("rejects remote upload inputs without consuming existing references", () => {
		assert.deepEqual(
			normalizeUploadFileInput({
				type: "input_file",
				file_url: "https://files.example/src/main.ts?download=1",
				filename: "main.ts",
			}),
			{
				invalidReason: "missing generic file upload data",
				mime: "text/typescript",
				filename: "main.ts",
			},
		);
		assert.equal(
			normalizeUploadFileInput({
				type: "file",
				fileData: {
					fileUri: "https://files.example/main.py",
					mimeType: "text/x-python",
					displayName: "main.py",
				},
			}),
			null,
		);
		assert.equal(
			normalizeUploadFileInput({ type: "input_file", file_id: "file-1" }),
			null,
		);
		assert.equal(normalizeUploadFileInput(42), null);
	});
});
