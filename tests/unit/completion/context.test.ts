// @ts-nocheck
import { describe, test } from "vitest";
import { mergeFileRefs } from "../../../src/completion/context";
import { assert } from "../assertions.js";

describe("completion context", () => {
	test("deduplicates merged completion file references", () => {
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
