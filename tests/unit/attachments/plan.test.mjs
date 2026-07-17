import { describe, test } from "vitest";
import {
	createAttachmentPlan,
	MAX_ATTACHMENTS_PER_REQUEST,
	mergeAttachmentPlans,
} from "../../../src/attachments/plan";
import { assert } from "../assertions.js";

describe("attachment plans", () => {
	test("orders image and file candidates with normalized metadata", () => {
		const plan = createAttachmentPlan({
			images: [
				{ b64: "aW1hZ2U=", mime: "image/jpeg", filename: "../photo.jpg" },
				{
					url: "https://images.example/remote.png",
					filename: "remote.png",
				},
			],
			files: [
				{ b64: "ZmlsZQ==", mime: "text/plain" },
				{ invalidReason: "missing bytes", filename: "bad.txt" },
			],
			existingFileRefs: ["ref-a", { id: "ref-b", name: "b.txt" }],
			maxFiles: 3,
		});

		assert.deepEqual(plan.candidates, [
			{
				id: "att_1",
				kind: "image",
				role: "request",
				source: { type: "base64", data: "aW1hZ2U=" },
				filename: "photo.jpg",
				mime: "image/jpeg",
			},
			{
				id: "att_2",
				kind: "file",
				role: "request",
				source: { type: "base64", data: "ZmlsZQ==" },
				filename: "file-2.txt",
				mime: "text/plain",
			},
		]);
		assert.deepEqual(plan.existingFileRefs, [
			"ref-a",
			{ id: "ref-b", name: "b.txt" },
		]);
		assert.deepEqual(plan.dropped, [
			{
				kind: "image",
				code: "invalid_image_input",
				message: "invalid image input",
				filename: "remote.png",
			},
			{
				kind: "file",
				code: "invalid_file_input",
				message: "missing bytes",
				filename: "bad.txt",
			},
		]);
		assert.equal(plan.maxFiles, 3);
	});

	test("records explicit and default max-file overflow", () => {
		const explicit = createAttachmentPlan({
			files: Array.from({ length: 3 }, (_, index) => ({
				b64: "AA==",
				filename: `f${index}.txt`,
			})),
			maxFiles: 2,
		});
		assert.equal(explicit.candidates.length, 2);
		assert.deepEqual(explicit.dropped, [
			{
				kind: "file",
				code: "too_many_files",
				message: "exceeded maximum of 2 attachments per request",
				filename: "f2.txt",
			},
		]);

		const defaults = createAttachmentPlan({
			files: Array.from({ length: MAX_ATTACHMENTS_PER_REQUEST + 1 }, () => ({
				b64: "AA==",
			})),
		});
		assert.equal(defaults.candidates.length, MAX_ATTACHMENTS_PER_REQUEST);
		assert.equal(defaults.dropped.length, 1);
		assert.match(defaults.dropped[0].message, /maximum of 50 attachments/);
	});

	test("merges plans with minimum capacity and fresh candidate IDs", () => {
		const merged = mergeAttachmentPlans(
			{
				candidates: [
					{
						id: "source-a",
						kind: "image",
						role: "request",
						source: { type: "base64", data: "aW1hZ2U=" },
						filename: "image.png",
						mime: "image/png",
					},
				],
				existingFileRefs: ["ref-a"],
				dropped: [],
				maxFiles: 4,
			},
			{
				candidates: [
					{
						id: "source-b",
						kind: "file",
						role: "request",
						source: { type: "base64", data: "ZmlsZQ==" },
						filename: "file.txt",
						mime: "text/plain",
					},
					{
						id: "source-c",
						kind: "file",
						role: "request",
						source: { type: "base64", data: "b3ZlcmZsb3c=" },
						filename: "overflow.txt",
					},
				],
				existingFileRefs: ["ref-a", "ref-b"],
				dropped: [
					{ kind: "image", code: "invalid_image_input", message: "bad image" },
				],
				maxFiles: 2,
			},
		);

		assert.deepEqual(
			merged.candidates.map((candidate) => candidate.id),
			["att_1", "att_2"],
		);
		assert.deepEqual(merged.existingFileRefs, ["ref-a", "ref-b"]);
		assert.equal(merged.maxFiles, 2);
		assert.deepEqual(
			merged.dropped.map((drop) => [drop.code, drop.filename || ""]),
			[
				["too_many_files", "overflow.txt"],
				["invalid_image_input", ""],
			],
		);
	});
});
