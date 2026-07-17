import { describe, test } from "vitest";
import {
	buildCorrectToolExamples,
	buildReadToolCacheGuard,
	exampleBasicParams,
	exampleNestedParams,
	exampleScriptParams,
	firstBasicExample,
	firstNBasicExamples,
	firstNestedExample,
	firstScriptExample,
	hasReadLikeTool,
	renderToolExampleBlock,
	uniqueToolNames,
} from "../../../src/toolcall/prompt-examples";
import { assert } from "../assertions.js";

describe("toolcall", () => {
	test("builds prompt examples only for known tool shapes", async () => {
		assert.equal(hasReadLikeTool([" read-file ", "Search"]), true);
		assert.equal(hasReadLikeTool("Read"), false);
		assert.equal(
			buildReadToolCacheGuard(["read_file"]).includes("Read-tool cache guard"),
			true,
		);
		assert.equal(buildReadToolCacheGuard(["Search"]), "");
		assert.deepEqual(uniqueToolNames([" Read ", "Read", "", null, "Glob"]), [
			"Read",
			"Glob",
		]);

		const names = ["Unknown", "Read", "Glob", "Task", "Bash", "write_to_file"];
		assert.deepEqual(firstBasicExample(names), {
			name: "Read",
			params: exampleBasicParams("Read"),
		});
		assert.deepEqual(
			firstNBasicExamples(names, 2).map((example) => example.name),
			["Read", "Glob"],
		);
		assert.equal(firstNestedExample(names).name, "Task");
		assert.equal(firstScriptExample(names).name, "Bash");
		assert.equal(exampleBasicParams("Unknown"), null);
		assert.equal(exampleNestedParams("Unknown"), null);
		assert.equal(exampleScriptParams("Unknown"), null);

		const block = renderToolExampleBlock([
			{ name: 'Run"Now', params: exampleScriptParams("execute_command") },
		]);
		assert.match(block, /<\|DSML\|invoke name="Run&quot;Now">/);
		assert.match(block, /<!\[CDATA\[cat > \/tmp\/test_escape\.sh/);
		assert.match(block, /<\/\|DSML\|tool_calls>$/);

		const examples = buildCorrectToolExamples(names);
		assert.match(examples, /Example A - Single tool/);
		assert.match(examples, /Example B - Two tools in parallel/);
		assert.match(examples, /Example C - Tool with nested XML parameters/);
		assert.match(examples, /Example D - Tool with long script using CDATA/);
		assert.equal(buildCorrectToolExamples(["Unknown"]), "");
	});
});
