// @ts-nocheck
import { describe, test } from "vitest";
import {
	appendExistingFileRefs,
	existingFileRefFromRecord,
	recognizedFileRefID,
	recognizedFileRefKey,
} from "../../../src/attachments/refs";
import { assert } from "../assertions.js";

describe("attachment references", () => {
	test("flattens aliases and keeps the first reference for each ID", () => {
		const out = [{ ref: "ref-a", name: "original" }];
		appendExistingFileRefs(out, [
			"ref-a",
			["ref-b", { fileRef: "ref-c", filename: "c.txt" }],
			{ id: "ref-c", name: "duplicate.txt" },
			{ file_id: "ref-d", file_name: "d.txt" },
			{ ref: "ref-e", name: "  e.txt  " },
		]);
		assert.deepEqual(out, [
			{ ref: "ref-a", name: "original" },
			"ref-b",
			{ id: "ref-c", name: "c.txt" },
			{ id: "ref-d", name: "d.txt" },
			{ id: "ref-e", name: "e.txt" },
		]);
	});

	test("ignores empty and unsupported reference values", () => {
		const out = [];
		appendExistingFileRefs(out, [null, 1, {}, { id: "  " }, [undefined]]);
		assert.deepEqual(out, []);
	});

	test("recognizes every alias while keeping direct id context-sensitive", () => {
		for (const key of ["file_id", "fileId", "file_ref", "fileRef", "ref"])
			assert.equal(recognizedFileRefID({ [key]: " ref-1 " }, false), "ref-1");

		assert.equal(recognizedFileRefID({ id: "direct" }, false), null);
		assert.equal(recognizedFileRefID({ id: "direct" }, true), "direct");
		assert.equal(recognizedFileRefKey({ file_ref: "keyed" }), "keyed");
		assert.deepEqual(
			existingFileRefFromRecord(
				{ file: { id: "nested", filename: "../nested.txt" } },
				false,
			),
			{ id: "nested", name: "nested.txt" },
		);
	});
});
