import { describe, test } from "vitest";
import {
	attachmentDrop,
	droppedAttachmentNote,
} from "../../../src/attachments/notes";
import type {
	AttachmentDropReason,
	AttachmentKind,
} from "../../../src/attachments/types";
import { assert } from "../assertions.js";

describe("attachment drop notes", () => {
	test("uses deterministic default messages for every drop reason", () => {
		const reasons: ReadonlyArray<
			readonly [AttachmentKind, AttachmentDropReason, string]
		> = [
			["image", "invalid_image_input", "invalid image input"],
			["file", "invalid_file_input", "invalid file input"],
			["file", "invalid_base64", "invalid base64 payload"],
			["file", "invalid_remote_url", "invalid remote URL"],
			["file", "file_too_large", "file attachment is too large"],
			["image", "image_too_large", "image attachment is too large"],
			["file", "too_many_files", "too many attachments"],
			["file", "upload_failed", "attachment upload failed"],
		];

		for (const [kind, code, message] of reasons) {
			assert.equal(attachmentDrop(kind, code).message, message);
		}
	});

	test("groups drops by kind and message in first-seen order", () => {
		const drops = [
			attachmentDrop(
				"file",
				"invalid_base64",
				undefined,
				"../bad\u0000\r\nname.txt",
			),
			attachmentDrop("file", "invalid_base64"),
			attachmentDrop("image", "too_many_files", "custom limit"),
			attachmentDrop("image", "too_many_files", "custom limit"),
		];

		assert.equal(drops[0]?.filename, "bad  name.txt");
		assert.equal(
			droppedAttachmentNote(drops),
			"\n\n[Note: 2 file(s) were provided but ignored - invalid base64 payload.]" +
				"\n\n[Note: 2 image(s) were provided but ignored - custom limit.]",
		);
		assert.equal(droppedAttachmentNote([]), "");
		assert.equal(droppedAttachmentNote(null), "");
	});
});
