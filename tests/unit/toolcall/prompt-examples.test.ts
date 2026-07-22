import { describe, test } from "vitest";
import {
	buildCorrectToolExamples,
	buildReadToolCacheGuard,
} from "../../../src/toolcall/prompt-examples";
import { assert } from "../assertions.js";

describe("toolcall", () => {
	test("builds prompt examples only for known tool shapes", async () => {
		assert.equal(
			buildReadToolCacheGuard([" read-file ", "Search"]).includes(
				"Read-tool cache guard",
			),
			true,
		);
		assert.equal(
			buildReadToolCacheGuard(["read_file"]).includes("Read-tool cache guard"),
			true,
		);
		assert.equal(buildReadToolCacheGuard(["Search"]), "");
		// Non-array tool name lists are ignored by the public builders.
		assert.equal(buildReadToolCacheGuard("Read"), "");

		const names = ["Unknown", "Read", "Glob", "Task", "Bash", "write_to_file"];
		const examples = buildCorrectToolExamples(names);
		assert.match(examples, /CORRECT EXAMPLES:/);
		assert.match(examples, /Example A - Single tool/);
		assert.match(examples, /Example B - Two tools in parallel/);
		assert.match(examples, /Example C - Tool with nested XML parameters/);
		assert.match(examples, /Example D - Tool with long script using CDATA/);
		// Single-tool example should prefer the first known basic tool name.
		assert.match(examples, /<\|DSML\|invoke name="Read">/);
		assert.match(examples, /README\.md/);
		// Parallel example should include a second basic tool.
		assert.match(examples, /<\|DSML\|invoke name="Glob">/);
		// Nested XML example should include Task.
		assert.match(examples, /<\|DSML\|invoke name="Task">/);
		// Script/CDATA example should include Bash and CDATA content.
		assert.match(examples, /<\|DSML\|invoke name="Bash">/);
		assert.match(examples, /<!\[CDATA\[cat > \/tmp\/test_escape\.sh/);
		assert.match(examples, /<\/\|DSML\|tool_calls>/);

		// Unknown-only tool lists produce no example block.
		assert.equal(buildCorrectToolExamples(["Unknown"]), "");
		// Attribute escaping for tool names is exercised via script-capable tools.
		const escaped = buildCorrectToolExamples(["execute_command"]);
		assert.match(escaped, /Example D - Tool with long script using CDATA/);
		assert.match(escaped, /<!\[CDATA\[cat > \/tmp\/test_escape\.sh/);
		assert.match(escaped, /<\/\|DSML\|tool_calls>/);

		// Unique name handling: duplicates should not prevent a single example.
		const dupes = buildCorrectToolExamples([
			" Read ",
			"Read",
			"",
			null,
			"Glob",
		]);
		assert.match(dupes, /Example A - Single tool/);
		assert.match(dupes, /Example B - Two tools in parallel/);
	});
});
