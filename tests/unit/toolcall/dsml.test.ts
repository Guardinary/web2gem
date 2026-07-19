import { describe, test } from "vitest";
import { isRecord, type UnknownRecord } from "../../../src/shared/types";
import {
	normalizeDSMLToolCallMarkup,
	parseCanonicalDSMLToolCallsFast,
	parseDSMLToolCallsDetailed,
	parseMarkupValue,
	parseScalarValue,
	parseToolCalls,
	restoreToolCallProtectedMarkdown,
	shouldSkipToolCallParsingForCodeFenceExample,
	stripFencedCodeBlocks,
	unwrapToolArgumentMarkdown,
} from "../../../src/toolcall/dsml";
import { assert } from "../assertions.js";

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a value");
	return value;
}

function record(value: unknown): UnknownRecord {
	if (!isRecord(value)) throw new Error("expected an object");
	return value;
}

describe("toolcall", () => {
	test("uses canonical DSML fast path for plain XML tool blocks", async () => {
		const longPath = "x".repeat(16 * 1024);
		const candidate = `<tool_calls><invoke name="Read"><parameter name="path"><![CDATA[${longPath}]]></parameter></invoke></tool_calls>`;
		const fast = parseCanonicalDSMLToolCallsFast(candidate);
		const fastResult = required(fast);
		assert.equal(fastResult.cleanText, "");
		assert.equal(fastResult.sawToolCallSyntax, true);
		assert.equal(required(fastResult.calls[0]).name, "Read");
		assert.equal(record(required(fastResult.calls[0]).input).path, longPath);

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
	test("declines non-canonical DSML fast path inputs", async () => {
		assert.equal(
			parseCanonicalDSMLToolCallsFast(
				'```xml\n<tool_calls><invoke name="Read"></invoke></tool_calls>\n```',
			),
			null,
		);
		assert.equal(
			parseCanonicalDSMLToolCallsFast(
				'<tool-calls><invoke name="Read"></invoke></tool-calls>',
			),
			null,
		);
		assert.equal(
			parseCanonicalDSMLToolCallsFast(
				"＜tool_calls＞＜invoke name＝＂Read＂＞＜/invoke＞＜/tool_calls＞",
			),
			null,
		);
		assert.equal(
			parseCanonicalDSMLToolCallsFast(
				'<tool_calls><invoke name="Read"><parameter name="path">`README.md`</parameter></invoke></tool_calls>',
			),
			null,
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
		assert.equal(stripFencedCodeBlocks(fencedExample), "keep\nafter");
		assert.equal(
			shouldSkipToolCallParsingForCodeFenceExample(fencedExample),
			true,
		);
		const detailed = parseDSMLToolCallsDetailed(
			"<tool_calls><invoke></invoke></tool_calls>",
		);
		assert.equal(detailed.sawToolCallSyntax, true);
		assert.deepEqual(detailed.calls, []);
	});

	test("unwraps markdown arguments and rejects invalid restoration inputs", async () => {
		assert.deepEqual(
			Reflect.apply(restoreToolCallProtectedMarkdown, undefined, [
				null,
				() => "",
			]),
			[],
		);
		assert.deepEqual(
			Reflect.apply(restoreToolCallProtectedMarkdown, undefined, [
				[{ name: "Read", input: {} }],
				null,
			]),
			[],
		);
		assert.equal(
			unwrapToolArgumentMarkdown('```json\n{"ok":true}\n```'),
			'{"ok":true}',
		);
		assert.equal(unwrapToolArgumentMarkdown("plain text"), "plain text");
	});

	test("normalizes DSML aliases and escaped scalar markup", async () => {
		const normalized = normalizeDSMLToolCallMarkup(
			'<GeminiToolCalls><GeminiInvoke name="Read"></GeminiInvoke></GeminiToolCalls>',
		);
		assert.equal(
			normalized,
			'<tool_calls><invoke name="Read"></invoke></tool_calls>',
		);
		const [clean, calls] = parseToolCalls(normalized, [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.equal(clean, "");
		assert.equal(required(calls[0]).function.name, "Read");

		assert.equal(
			parseMarkupValue("&lt;item&gt;a&lt;/item&gt;&lt;item&gt;2&lt;/item&gt;"),
			"<item>a</item><item>2</item>",
		);
		assert.equal(
			parseMarkupValue(
				"&lt;name&gt;Read&lt;/name&gt;&lt;count&gt;2&lt;/count&gt;",
			),
			"<name>Read</name><count>2</count>",
		);
		assert.equal(parseScalarValue("1e999"), "1e999");
		assert.equal(parseScalarValue("{not json}"), "{not json}");
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
