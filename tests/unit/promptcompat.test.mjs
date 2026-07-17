import { describe, test } from "vitest";
import { mergeFileRefs } from "../../src/completion/context";
import { firstNonEmptyString } from "../../src/shared/strings";
import { assert } from "./assertions.js";

describe("prompt compatibility", () => {
	test("selects the first non-empty shared string", () => {
		assert.equal(firstNonEmptyString(null, "  ", " ok "), "ok");
	});

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
