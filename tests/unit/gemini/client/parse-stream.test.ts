import { describe, test } from "vitest";
import { createStreamTextExtractor } from "../../../../src/gemini/client/parse-stream";
import { assert } from "../../assertions.js";
import { wrbTextLine } from "../_support/client-fixtures.js";

describe("Gemini stream text extraction", () => {
	test("streams only new text deltas from repeated WRB lines", () => {
		const extractor = createStreamTextExtractor();
		assert.deepEqual(
			[...extractor.consumeLine(wrbTextLine([" hello"]))],
			["hello"],
		);
		assert.deepEqual(
			[...extractor.consumeLine(wrbTextLine([" hello world"]))],
			[" world"],
		);
		assert.deepEqual(
			[...extractor.consumeLine(wrbTextLine([" hello world"]))],
			[],
		);
	});
	test("streams long cumulative WRB text without losing append state", () => {
		const extractor = createStreamTextExtractor();
		let cumulative = "";
		let emitted = "";
		for (let i = 0; i < 512; i++) {
			cumulative += `${String(i).padStart(4, "0")}:${"x".repeat(123)}\n`;
			emitted += [...extractor.consumeLine(wrbTextLine([cumulative]))].join("");
		}
		assert.equal(emitted, cumulative.trimStart());
		assert.deepEqual(
			[...extractor.consumeLine(wrbTextLine([cumulative.slice(0, -256)]))],
			[],
		);
		assert.deepEqual(
			[...extractor.consumeLine(wrbTextLine([`${cumulative}tail`]))],
			["tail"],
		);
	});
	test("streams visible deltas after artifact-bearing cumulative chunks", () => {
		const extractor = createStreamTextExtractor();
		const artifact = [
			"answer",
			"```python?code_reference&code_event_index=1",
			"print('hidden')",
			"```",
		].join("\n");
		assert.equal(
			[...extractor.consumeLine(wrbTextLine([artifact]))].join(""),
			"answer\n",
		);
		assert.deepEqual(
			[...extractor.consumeLine(wrbTextLine([`${artifact}\nmore visible`]))],
			["more visible"],
		);
	});
});
