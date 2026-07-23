import { describe, test } from "vitest";
import {
	parseDSMLToolCallsDetailed,
	parseToolCalls,
} from "../../../src/toolcall/dsml";
import { assert } from "../assertions.js";
import { required } from "./_support/assertions.js";

describe("toolcall", () => {
	test("uses canonical DSML fast path for plain XML tool blocks", async () => {
		const longPath = "x".repeat(16 * 1024);
		const candidate = `<tool_calls><invoke name="Read"><parameter name="path"><![CDATA[${longPath}]]></parameter></invoke></tool_calls>`;
		const detailed = parseDSMLToolCallsDetailed(candidate);
		assert.equal(detailed.cleanText, "");
		assert.equal(detailed.sawToolCallSyntax, true);
		assert.equal(required(detailed.calls[0]).name, "Read");

		const [clean, toolCalls] = parseToolCalls(candidate, [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.equal(clean, "");
		assert.equal(
			JSON.parse(required(toolCalls[0]).function.arguments).path,
			longPath,
		);
	});
	test("accepts fullwidth confusable DSML tool markup", async () => {
		const confusable =
			"＜|DSML|tool_calls＞＜|DSML|invoke name＝＂Read＂＞＜|DSML|parameter name＝＂file_path＂＞README.md＜/|DSML|parameter＞＜/|DSML|invoke＞＜/|DSML|tool_calls＞";
		const [clean, toolCalls] = parseToolCalls(confusable, [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.equal(clean, "");
		assert.equal(required(toolCalls[0]).function.name, "Read");
	});
	test("keeps legacy fenced markdown tool call JSON as plain text", async () => {
		const fenced =
			'before\n```tool_call\n{"name":"Read","arguments":{"file_path":"README.md"}}\n```\nafter';
		const [clean, toolCalls] = parseToolCalls(fenced, [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.equal(clean, fenced);
		assert.deepEqual(toolCalls, []);
	});
	test("accepts DSML invoke blocks with missing opening root wrapper", async () => {
		const text =
			'<|DSML|invoke name="Read"><|DSML|parameter name="file_path">README.md</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>';
		const [clean, toolCalls] = parseToolCalls(text, [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.equal(clean, "");
		assert.equal(required(toolCalls[0]).function.name, "Read");
		assert.equal(
			JSON.parse(required(toolCalls[0]).function.arguments).file_path,
			"README.md",
		);
	});
	test("accepts DSML aliases JSON invoke bodies and nested parameter values", async () => {
		const jsonBody =
			'<tool-calls><invoke name="Search">{"arguments":{"query":"docs"}}</invoke></tool-calls>';
		const [, jsonCalls] = parseToolCalls(jsonBody, [
			{
				type: "function",
				function: { name: "Search", parameters: { type: "object" } },
			},
		]);
		assert.equal(required(jsonCalls[0]).function.name, "Search");
		assert.deepEqual(JSON.parse(required(jsonCalls[0]).function.arguments), {
			query: "docs",
		});

		const nested = [
			'<tool_calls><invoke name="MultiEdit">',
			'<parameter name="edits"><item><old_string>foo</old_string><new_string><![CDATA[bar]]></new_string></item></parameter>',
			'<parameter name="flags"><item>true</item><item>null</item><item>2</item></parameter>',
			'<parameter name="pairs">{"a":1},{"b":2}</parameter>',
			'<parameter name="file_path">`README.md`</parameter>',
			"</invoke></tool_calls>",
		].join("");
		const [, nestedCalls] = parseToolCalls(nested, [
			{
				type: "function",
				function: { name: "MultiEdit", parameters: { type: "object" } },
			},
		]);
		const args = JSON.parse(required(nestedCalls[0]).function.arguments);
		assert.deepEqual(args.edits, [{ old_string: "foo", new_string: "bar" }]);
		assert.deepEqual(args.flags, [true, null, 2]);
		assert.deepEqual(args.pairs, [{ a: 1 }, { b: 2 }]);
		assert.equal(args.file_path, "README.md");
	});
	test("skips fenced DSML examples while retaining malformed syntax evidence", async () => {
		const fencedExample =
			'keep\n```xml\n<tool_calls><invoke name="Read"></invoke></tool_calls>\n```\nafter';
		const [clean, toolCalls] = parseToolCalls(fencedExample);
		assert.equal(clean, fencedExample.trim());
		assert.deepEqual(toolCalls, []);
		const detailed = parseDSMLToolCallsDetailed(
			"<tool_calls><invoke></invoke></tool_calls>",
		);
		assert.equal(detailed.sawToolCallSyntax, true);
		assert.deepEqual(detailed.calls, []);
	});

	test("does not invent tool calls from incomplete or example-like markup", async () => {
		const tools = [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		];

		// Incomplete open candidate: syntax may be visible, but no executable call.
		const incomplete =
			'prefix <tool_calls><invoke name="Read"><parameter name="path">README.md';
		const [incompleteClean, incompleteCalls] = parseToolCalls(
			incomplete,
			tools,
		);
		assert.deepEqual(incompleteCalls, []);
		assert.match(incompleteClean, /prefix/);
		assert.match(incompleteClean, /<tool_calls>/);

		// Fenced XML remains documentation, not an executable tool call.
		const fenced =
			'note\n```xml\n<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>\n```\nend';
		const [fencedClean, fencedCalls] = parseToolCalls(fenced, tools);
		assert.deepEqual(fencedCalls, []);
		assert.match(fencedClean, /```xml/);
		assert.match(fencedClean, /README\.md/);

		// Backtick-wrapped parameter values still parse through the public path.
		const backticked =
			'<tool_calls><invoke name="Read"><parameter name="path">`README.md`</parameter></invoke></tool_calls>';
		const [btClean, btCalls] = parseToolCalls(backticked, tools);
		assert.equal(btClean, "");
		assert.equal(required(btCalls[0]).function.name, "Read");
		assert.equal(
			JSON.parse(required(btCalls[0]).function.arguments).path,
			"README.md",
		);
	});

	test("parses markup parameter values through public tool-call entrypoints", async () => {
		const tools = [
			{
				type: "function",
				function: { name: "Write", parameters: { type: "object" } },
			},
		];

		// Nested markup + CDATA + fenced markdown argument unwrap + scalars.
		const nested = [
			'<tool_calls><invoke name="Write">',
			'<parameter name="payload"><name>Read</name><count>2</count></parameter>',
			'<parameter name="items"><item>a</item><item><![CDATA[b&c]]></item></parameter>',
			'<parameter name="doc"><![CDATA[```json\n{"ok":true}\n```]]></parameter>',
			'<parameter name="flag">true</parameter>',
			'<parameter name="none">null</parameter>',
			'<parameter name="huge">1e999</parameter>',
			'<parameter name="broken">{not json}</parameter>',
			'<parameter name="entities">&lt;tag&gt;</parameter>',
			"</invoke></tool_calls>",
		].join("");
		const [clean, calls] = parseToolCalls(nested, tools);
		assert.equal(clean, "");
		const args = JSON.parse(required(calls[0]).function.arguments);
		assert.deepEqual(args.payload, { name: "Read", count: 2 });
		assert.deepEqual(args.items, ["a", "b&c"]);
		// CDATA-preserved fenced text is not unwrapped unless markdown restore runs.
		assert.equal(args.doc, '```json\n{"ok":true}\n```');
		assert.equal(args.flag, true);
		assert.equal(args.none, null);
		// Non-finite scientific notation stays a string.
		assert.equal(args.huge, "1e999");
		assert.equal(args.broken, "{not json}");
		assert.equal(args.entities, "<tag>");

		// Entity-encoded markup is decoded to text; only real XML children become objects.
		const encoded =
			'<tool_calls><invoke name="Write"><parameter name="blob">&lt;name&gt;Read&lt;/name&gt;&lt;count&gt;2&lt;/count&gt;</parameter></invoke></tool_calls>';
		const [, encodedCalls] = parseToolCalls(encoded, tools);
		const encodedArgs = JSON.parse(
			required(encodedCalls[0]).function.arguments,
		);
		assert.equal(encodedArgs.blob, "<name>Read</name><count>2</count>");
	});

	test("normalizes Gemini-prefixed tool aliases through public parse", async () => {
		const aliased =
			'<GeminiToolCalls><GeminiInvoke name="Read"></GeminiInvoke></GeminiToolCalls>';
		const [clean, calls] = parseToolCalls(aliased, [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.equal(clean, "");
		assert.equal(required(calls[0]).function.name, "Read");
	});
	test("keeps legacy tool_call fences as plain text", async () => {
		const legacy = [
			"before",
			"```tool_call",
			'{"arguments":{"ignored":true}}',
			"```",
			"middle",
			"```tool_call",
			'{"name":"Run","args":{"cmd":"ls"}}',
			"```",
			"after",
		].join("\n");
		const [clean, toolCalls] = parseToolCalls(legacy, [
			{
				type: "function",
				function: { name: "Run", parameters: { type: "object" } },
			},
		]);
		assert.match(clean, /before/);
		assert.match(clean, /middle/);
		assert.match(clean, /after/);
		assert.match(clean, /```tool_call/);
		assert.match(clean, /\{"arguments":\{"ignored":true\}\}/);
		assert.match(clean, /\{"name":"Run"/);
		assert.deepEqual(toolCalls, []);
	});
});
