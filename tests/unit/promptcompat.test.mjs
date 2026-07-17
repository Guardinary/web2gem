import { describe, test } from "vitest";
import {
	normalizeUploadFileInput,
	parseImageUrl,
	parseUploadUrl,
	uploadFilenameFromObject,
} from "../../src/attachments/input";
import {
	filenameFromUrl,
	genericFilenameFromMime,
	imageFilenameFromMime,
	mimeFromFilename,
	sanitizeUploadFilename,
} from "../../src/attachments/mime";
import { mergeFileRefs } from "../../src/completion/context";
import { firstNonEmptyString } from "../../src/shared/strings";
import { assert } from "./assertions.js";

describe("prompt compatibility", () => {
	test("sanitizes media filenames and maps image mime extensions", async () => {
		assert.deepEqual(
			parseImageUrl("data:IMAGE/PNG;charset=utf-8;base64,AAAA"),
			{ b64: "AAAA", mime: "image/png" },
		);
		assert.equal(parseImageUrl("https://example.com/a.png"), null);
		assert.equal(parseImageUrl("ftp://example.com/a.png"), null);
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
		assert.equal(firstNonEmptyString(null, "  ", " ok "), "ok");
		assert.equal(
			uploadFilenameFromObject({
				inline_data: { display_name: " inline.gif " },
			}),
			"inline.gif",
		);
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
		assert.equal(mimeFromFilename("main.py"), "text/x-python");
		assert.deepEqual(parseUploadUrl("data:text/plain;base64,QQ=="), {
			b64: "QQ==",
			mime: "text/plain",
		});
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
	test("deduplicates merged completion file references", async () => {
		assert.deepEqual(
			mergeFileRefs(
				["file-a", { ref: "file-b", name: "b" }],
				[{ fileRef: "file-b", name: "duplicate" }, { id: "file-c" }, null],
			),
			["file-a", { ref: "file-b", name: "b" }, { id: "file-c" }],
		);
		assert.equal(mergeFileRefs(null, [], [null]), null);
	});
});
