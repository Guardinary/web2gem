import { beforeEach, describe, test } from "vitest";
import { prepareOpenAIGeminiContext } from "../../src/completion/context";
import { prepareContextFilesWithUploader } from "../../src/completion/context-files";
import { finalizeOpenAICompletionResult } from "../../src/completion/turn";
import { streamOpenAIChatWithToolSieve } from "../../src/http/openai/chat-stream";
import { streamResponsesWithToolSieve } from "../../src/http/openai/responses-stream";
import { parseOpenAIMessages } from "../../src/promptcompat/message-model";
import { messagesToPrompt } from "../../src/promptcompat/messages";
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
} from "../../src/toolcall/dsml";
import {
	isInsideMarkdownFence,
	isInsideSimpleMarkdownCodeSpan,
	isMarkdownProtectedPosition,
	markdownProtectedRanges,
	markdownProtectedSpanStartAtCut,
	markdownProtectedTailStart,
	maskMarkdownProtectedSpans,
	openMarkdownCodeSpanStart,
	openMarkdownFenceStart,
	parseMarkdownFenceLine,
} from "../../src/toolcall/markdown";
import {
	ensureStreamToolCallID,
	formatOpenAIStreamToolCalls,
	formatOpenAIToolCalls,
} from "../../src/toolcall/openai-format";
import {
	allowedToolNameFromItem,
	buildToolChoiceInstructionFromPolicy,
	extractToolNames,
	filterToolsByPolicy,
	namesToSet,
	parseAllowedToolNames,
	parseForcedToolName,
	parseOpenAIToolChoicePolicy,
	policyHasAllowed,
	toolPolicyAllows,
	validateRequiredToolCalls,
	validateToolPolicyCalls,
} from "../../src/toolcall/policy-openai";
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
} from "../../src/toolcall/prompt-examples";
import {
	formatPromptParamValue,
	formatPromptToolCallBlock,
	isSafeXmlElementName,
} from "../../src/toolcall/prompt-format";
import {
	indentPromptParameters,
	promptCDATA,
	wrapParameter,
	xmlEscapeAttr,
} from "../../src/toolcall/prompt-xml";
import {
	buildToolSchemaIndex,
	looksLikeArraySchema,
	looksLikeObjectSchema,
	normalizeParsedToolCallsForSchemas,
	normalizeToolValueWithSchema,
	shouldCoerceSchemaToString,
	stringifySchemaValue,
} from "../../src/toolcall/schema-normalize";
import {
	buildStructuredOutputRequirement,
	canonicalizeStructuredOutputText,
	extractFirstJsonDocument,
	finalizeStructuredOutputText,
	getStructuredResponseFormat,
	parseStructuredJsonCandidate,
	STRUCTURED_JSON_NOT_FOUND,
	validateStructuredOutputValue,
} from "../../src/completion/structured-output";
import { jsonValuesEqual } from "../../src/shared/json-schema";
import {
	findToolCallSyntaxCandidateStart,
	containsToolMarkupSyntax,
	isPartialToolCallSyntaxPrefix,
} from "../../src/toolcall/syntax-probe";
import {
	createToolBundle,
	filterToolBundleByPolicy,
	nullableOpenAIFunctionTools,
	toolCallInstructionsFor,
	toolNamesForPromptSource,
	toolPromptBlockFor,
	toolsContextTranscriptFor,
} from "../../src/toolcall/tool-bundle";
import {
	extractToolMeta,
	firstNonNil,
	toolDefsFromTools,
	toolFunctionDeclarations,
	toolItemsFromTools,
	toolMetasFromTools,
} from "../../src/toolcall/tool-meta";
import {
	appendMarkupValue,
	decodeCDATA,
	decodeXmlEntities,
	findNextAnyXmlTag,
	findNextXmlTag,
	findTopLevelXmlElementBlocks,
	findXmlElementBlocks,
	findXmlTagEnd,
	parseTagAttributes,
	scanXmlTagAt,
	skipCDATAAt,
} from "../../src/toolcall/xml";
import {
	createToolSieveState,
	flushToolSieve,
	flushToolSievePlainPrefix,
	hasToolCallCloseSyntax,
	hasToolSieveSentinel,
	processToolSieveChunk,
	TOOL_SIEVE_PLAIN_TEXT_KEEP,
} from "../../src/toolcall/sieve";
import { assert } from "./assertions.js";
import { fakeStreamProvider, resetTestState } from "./helpers.js";

describe("toolcall", () => {
	beforeEach(resetTestState);
	const sieveState = (overrides = {}) =>
		Object.assign(createToolSieveState(), overrides);
	test("parses long plain text without tool calls", async () => {
		const plain = "plain text without tool syntax\n".repeat(8000);
		const [clean, toolCalls] = parseToolCalls(plain, [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.equal(clean, plain.trim());
		assert.deepEqual(toolCalls, []);
	});
	test("avoids expensive parsing for markup false positives", async () => {
		const falsePositive =
			"a < b and parameterless prose should stay plain\n".repeat(5000);
		assert.equal(containsToolMarkupSyntax(falsePositive), false);
		assert.equal(findToolCallSyntaxCandidateStart(falsePositive), -1);
		const [clean, toolCalls] = parseToolCalls(falsePositive, [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.equal(clean, falsePositive.trim());
		assert.deepEqual(toolCalls, []);
	});
	test("releases partial DSML sentinel when it becomes plain text", async () => {
		assert.equal(isPartialToolCallSyntaxPrefix("<|DS"), true);
		const state = createToolSieveState();
		const emitted = processToolSieveChunk(state, "hello <|DS");
		assert.deepEqual(emitted, ["hello "]);
		assert.equal(state.buffer, "<|DS");
		assert.equal(state.holdingToolCandidate, true);
		const released = processToolSieveChunk(
			state,
			" but this is not a tool tag",
		);
		assert.deepEqual(released, ["<|DS but this is not a tool tag"]);
		assert.equal(state.buffer, "");
		assert.equal(state.holdingToolCandidate, false);
	});
	test("keeps bounded plain text tail in tool sieve state", async () => {
		const state = createToolSieveState();
		const text = `a < b and parameterless prose ${"x".repeat(300)}`;
		const emitted = processToolSieveChunk(state, text);
		assert.equal(emitted.join("").length > 0, true);
		assert.equal(state.buffer.length <= 64, true);
		const flushed = flushToolSieve(state);
		assert.equal(emitted.join("") + flushed.text, text);
		assert.equal(flushed.toolCalls, null);
	});
	test("covers tool sieve helper state edges", async () => {
		assert.equal(hasToolSieveSentinel("plain text"), false);
		assert.equal(hasToolSieveSentinel("before <tool_calls>"), true);
		assert.equal(hasToolCallCloseSyntax("</tool_calls>"), true);
		assert.equal(flushToolSievePlainPrefix(null), null);

		const holding = {
			buffer: "x".repeat(100),
			holdingToolCandidate: true,
			sawToolClose: false,
			parsedToolCandidate: false,
		};
		assert.equal(flushToolSievePlainPrefix(holding), null);
		assert.equal(holding.buffer.length, 100);

		const sentinel = {
			buffer: "plain <tool_calls>",
			holdingToolCandidate: false,
			sawToolClose: false,
			parsedToolCandidate: false,
		};
		assert.equal(flushToolSievePlainPrefix(sentinel), null);

		const plain = {
			buffer: "p".repeat(100),
			holdingToolCandidate: false,
			sawToolClose: false,
			parsedToolCandidate: false,
		};
		const flushedPlain = flushToolSievePlainPrefix(plain);
		assert.deepEqual(flushedPlain, [
			"p".repeat(100 - TOOL_SIEVE_PLAIN_TEXT_KEEP),
		]);
		assert.equal(plain.buffer.length, TOOL_SIEVE_PLAIN_TEXT_KEEP);

		const parsed = sieveState({
			buffer: '<tool_calls><invoke name="Read"></invoke></tool_calls>',
			holdingToolCandidate: true,
			sawToolClose: true,
			parsedToolCandidate: true,
		});
		assert.deepEqual(processToolSieveChunk(parsed, ""), []);
		assert.equal(parsed.buffer.includes("<tool_calls>"), true);

		const malformedHeld = sieveState({
			buffer: "<tool_calls><invoke></invoke></tool_calls>",
			holdingToolCandidate: true,
			sawToolClose: true,
			parsedToolCandidate: false,
		});
		assert.deepEqual(processToolSieveChunk(malformedHeld, ""), []);
		assert.equal(malformedHeld.buffer.includes("<tool_calls>"), true);

		const malformed = sieveState({
			buffer: "</tool_calls>",
			holdingToolCandidate: true,
			sawToolClose: true,
			parsedToolCandidate: false,
		});
		assert.deepEqual(processToolSieveChunk(malformed, ""), []);
		assert.equal(malformed.buffer, "</tool_calls>");
		assert.equal(malformed.holdingToolCandidate, true);

		assert.deepEqual(flushToolSieve(null), {
			text: "",
			toolCalls: null,
		});
		assert.deepEqual(
			flushToolSieve(
				sieveState({
					buffer: "plain",
					holdingToolCandidate: false,
					sawToolClose: false,
					parsedToolCandidate: false,
				}),
			),
			{
				text: "plain",
				toolCalls: null,
			},
		);
	});
	test("holds complete DSML candidates until flush without leaking text", async () => {
		const chunkedState = createToolSieveState();
		const partialCandidate =
			'<|DSML|tool_calls><|DSML|invoke name="Read"><|DSML|parameter name="path">';
		assert.deepEqual(
			processToolSieveChunk(chunkedState, partialCandidate.slice(0, 32)),
			[],
		);
		assert.deepEqual(
			processToolSieveChunk(chunkedState, partialCandidate.slice(32)),
			[],
		);
		assert.equal(chunkedState.heldLength, partialCandidate.length);
		assert.equal(chunkedState.heldLength > chunkedState.buffer.length, true);

		const state = createToolSieveState();
		const candidate =
			'<|DSML|tool_calls><|DSML|invoke name="Read"><|DSML|parameter name="path"><![CDATA[README.md]]></|DSML|parameter></|DSML|invoke></|DSML|tool_calls>';
		assert.deepEqual(processToolSieveChunk(state, candidate.slice(0, 32)), []);
		assert.deepEqual(processToolSieveChunk(state, candidate.slice(32)), []);
		assert.equal(state.parsedToolCandidateResult.calls[0].name, "Read");
		assert.equal(state.parsedToolCandidateLength, candidate.length);
		const flushed = flushToolSieve(state);
		assert.equal(flushed.toolCalls[0].name, "Read");
		assert.equal(flushed.toolCalls[0].input.path, "README.md");
	});
	test("reparses cached tool candidates when more text arrives before flush", async () => {
		const state = createToolSieveState();
		const candidate =
			'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>';
		assert.deepEqual(processToolSieveChunk(state, candidate.slice(0, 32)), []);
		assert.deepEqual(processToolSieveChunk(state, candidate.slice(32)), []);
		assert.equal(state.parsedToolCandidateResult.calls[0].name, "Read");
		assert.deepEqual(processToolSieveChunk(state, " trailing text"), []);
		const flushed = flushToolSieve(state);
		assert.equal(flushed.text, "trailing text");
		assert.equal(flushed.toolCalls[0].name, "Read");
	});
	test("uses canonical DSML fast path for plain XML tool blocks", async () => {
		const longPath = "x".repeat(16 * 1024);
		const candidate = `<tool_calls><invoke name="Read"><parameter name="path"><![CDATA[${longPath}]]></parameter></invoke></tool_calls>`;
		const fast = parseCanonicalDSMLToolCallsFast(candidate);
		assert.equal(fast.cleanText, "");
		assert.equal(fast.sawToolCallSyntax, true);
		assert.equal(fast.calls[0].name, "Read");
		assert.equal(fast.calls[0].input.path, longPath);

		const [clean, toolCalls] = parseToolCalls(candidate, [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.equal(clean, "");
		assert.equal(JSON.parse(toolCalls[0].function.arguments).path, longPath);
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
	test("releases oversized unterminated tool candidates as plain text", async () => {
		const state = createToolSieveState();
		const prefix = "<tool_calls ";
		assert.deepEqual(processToolSieveChunk(state, prefix), []);
		const oversizedTail = "x".repeat(256 * 1024 + 1);
		const emitted = processToolSieveChunk(state, oversizedTail);
		assert.equal(emitted.join(""), prefix + oversizedTail);
		assert.equal(state.buffer, "");
		assert.equal(state.holdingToolCandidate, false);
	});
	test("releases oversized partial tool tag candidates as plain text", async () => {
		const state = createToolSieveState();
		const prefix = "<tool_calls ";
		assert.deepEqual(processToolSieveChunk(state, prefix), []);

		const oversizedTail = "x".repeat(256 * 1024 + 1);
		const emitted = processToolSieveChunk(state, oversizedTail);
		assert.equal(emitted.join(""), prefix + oversizedTail);
		assert.equal(state.buffer, "");
		assert.equal(state.heldLength, 0);
		assert.equal(state.holdingToolCandidate, false);
	});
	test("holds markdown tool-call fences until they are safe to flush", async () => {
		const state = createToolSieveState();
		const emitted = processToolSieveChunk(
			state,
			'before\n```tool_call\n{"name":"Read"',
		);
		assert.equal(emitted.join(""), "before\n");
		assert.match(state.buffer, /```tool_call/);
		const flushed = flushToolSieve(state);
		assert.match(flushed.text, /```tool_call/);
		assert.equal(flushed.toolCalls, null);
	});
	test("holds unterminated markdown tails without leaking partial code", async () => {
		const state = createToolSieveState();
		assert.deepEqual(processToolSieveChunk(state, "```js\nconst x = 1;"), []);
		assert.match(state.buffer, /```js/);

		const withPrefix = createToolSieveState();
		const emitted = processToolSieveChunk(
			withPrefix,
			"plain before\n```js\nconst x = 1;",
		);
		assert.equal(emitted.join(""), "plain before\n");
		assert.match(withPrefix.buffer, /^```js/);
	});
	test("releases markdown-protected tool-looking examples from holding state", async () => {
		const fenced = "```xml\n<tool_calls></tool_calls>\n```";
		const state = sieveState({
			buffer: fenced,
			holdingToolCandidate: true,
			sawToolClose: true,
			parsedToolCandidate: false,
		});
		const emitted = processToolSieveChunk(state, "");
		assert.equal(emitted.join(""), fenced);
		assert.equal(state.buffer, "");
		assert.equal(state.holdingToolCandidate, false);
	});
	test("protects markdown tool-looking examples while preserving real tool syntax", async () => {
		const text = [
			"before `<tool_calls></tool_calls>` after",
			"```xml",
			"<tool_calls></tool_calls>",
			"```",
			'real <tool_calls><invoke name="Read"></invoke></tool_calls>',
		].join("\n");
		const inlineIndex = text.indexOf("<tool_calls>");
		const fencedIndex = text.indexOf("<tool_calls>", inlineIndex + 1);
		const realIndex = text.lastIndexOf("<tool_calls>");
		assert.equal(isMarkdownProtectedPosition(text, inlineIndex), true);
		assert.equal(isInsideSimpleMarkdownCodeSpan(text, inlineIndex), true);
		assert.equal(isMarkdownProtectedPosition(text, fencedIndex), true);
		assert.equal(isInsideMarkdownFence(text, fencedIndex), true);
		assert.equal(isMarkdownProtectedPosition(text, realIndex), false);
		assert.equal(findToolCallSyntaxCandidateStart(text), realIndex);

		const masked = maskMarkdownProtectedSpans(text);
		assert.doesNotMatch(masked.text, /before `<tool_calls>/);
		assert.match(masked.text, /GEMINI_MD_PROTECTED_0_TOKEN/);
		assert.equal(masked.restore(masked.text), text);
		assert.equal(markdownProtectedRanges(text).length, 2);
	});
	test("detects markdown protected tails and validates fence lines", async () => {
		assert.deepEqual(parseMarkdownFenceLine("  ```js"), {
			ch: "`",
			len: 3,
			index: 2,
			canClose: false,
		});
		assert.deepEqual(parseMarkdownFenceLine("~~~"), {
			ch: "~",
			len: 3,
			index: 0,
			canClose: true,
		});
		assert.equal(parseMarkdownFenceLine("```bad`"), null);
		assert.equal(parseMarkdownFenceLine("```<xml>"), null);
		assert.equal(parseMarkdownFenceLine("```bad]"), null);

		const fenceTail = "prefix\n```js\nconst x = 1;";
		assert.equal(openMarkdownFenceStart(fenceTail), "prefix\n".length);
		assert.equal(markdownProtectedTailStart(fenceTail), "prefix\n".length);

		const codeTail = "prefix `inline";
		assert.equal(openMarkdownCodeSpanStart(codeTail), "prefix ".length);
		assert.equal(markdownProtectedTailStart(codeTail), "prefix ".length);

		const cutText = "hello `code span` after";
		assert.equal(
			markdownProtectedSpanStartAtCut(cutText, cutText.indexOf("span")),
			"hello ".length,
		);
		assert.equal(markdownProtectedSpanStartAtCut(cutText, 0), -1);
		assert.equal(markdownProtectedSpanStartAtCut(cutText, cutText.length), -1);
	});
	test("covers markdown protection CRLF ranges and inline span edges", async () => {
		const crlfFence = "intro\r\n```ts\r\nconst x = 1;\r\n```\r\noutro";
		const ranges = markdownProtectedRanges(crlfFence);
		assert.deepEqual(ranges, [
			{
				start: "intro\r\n".length,
				end: "intro\r\n```ts\r\nconst x = 1;\r\n```\r\n".length,
			},
		]);
		assert.equal(
			isMarkdownProtectedPosition(crlfFence, crlfFence.indexOf("const")),
			true,
		);
		assert.equal(
			isMarkdownProtectedPosition(crlfFence, crlfFence.indexOf("outro")),
			false,
		);

		const spans = "a ``two ticks`` and `one tick` done";
		assert.equal(
			isInsideSimpleMarkdownCodeSpan(spans, spans.indexOf("two")),
			true,
		);
		assert.equal(
			isInsideSimpleMarkdownCodeSpan(spans, spans.indexOf("one")),
			true,
		);
		assert.equal(
			isInsideSimpleMarkdownCodeSpan(spans, spans.indexOf("done")),
			false,
		);
		assert.equal(
			markdownProtectedSpanStartAtCut(
				"prefix ``unterminated",
				"prefix ``unterminated".length - 1,
			),
			"prefix ".length,
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
		assert.equal(toolCalls[0].function.name, "Read");
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
		assert.equal(toolCalls[0].function.name, "Read");
		assert.equal(
			JSON.parse(toolCalls[0].function.arguments).file_path,
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
		assert.equal(jsonCalls[0].function.name, "Search");
		assert.deepEqual(JSON.parse(jsonCalls[0].function.arguments), {
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
		const args = JSON.parse(nestedCalls[0].function.arguments);
		assert.deepEqual(args.edits, [{ old_string: "foo", new_string: "bar" }]);
		assert.deepEqual(args.flags, [true, null, 2]);
		assert.deepEqual(args.pairs, [{ a: 1 }, { b: 2 }]);
		assert.equal(args.file_path, "README.md");
	});
	test("covers DSML helper fallbacks for fenced examples escaped markup and aliases", async () => {
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

		assert.deepEqual(
			restoreToolCallProtectedMarkdown(null, () => ""),
			[],
		);
		assert.deepEqual(
			restoreToolCallProtectedMarkdown([{ name: "Read", input: {} }], null),
			[],
		);
		assert.equal(
			unwrapToolArgumentMarkdown('```json\n{"ok":true}\n```'),
			'{"ok":true}',
		);
		assert.equal(unwrapToolArgumentMarkdown("plain text"), "plain text");

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
		assert.equal(calls[0].function.name, "Read");

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
	test("builds equivalent prompt text from direct and bundled tools", async () => {
		const tools = [
			{
				type: "function",
				function: {
					name: "Search",
					description: "Search docs",
					parameters: {
						type: "object",
						properties: { query: { type: "string" } },
					},
				},
			},
		];
		const messages = parseOpenAIMessages([
			{ role: "user", content: "find docs" },
		]);
		const direct = messagesToPrompt(
			messages,
			{ bundle: createToolBundle(tools), choiceInstruction: "", include: true },
			1000000,
		);
		const bundle = createToolBundle(tools);
		const bundled = messagesToPrompt(
			messages,
			{
				bundle: createToolBundle(bundle),
				choiceInstruction: "",
				include: true,
			},
			1000000,
		);
		assert.equal(bundled.text, direct.text);
		assert.equal(bundled.metadata.hasToolPrompt, true);
		assert.equal(bundled.metadata.hasToolInstructions, true);
		assert.match(toolPromptBlockFor(bundle, ""), /"name": "Search"/);
		assert.doesNotMatch(
			toolPromptBlockFor(bundle, ""),
			/Gemini native hidden tool calls/,
		);
		const transcript = toolsContextTranscriptFor(bundle, "", "tools.txt");
		assert.match(transcript, /Available tool descriptions/);
		assert.match(transcript, /Tool call format instructions/);
		assert.match(transcript, /Gemini native hidden tool calls/);
		assert.match(transcript, /All of the above is system prompt content/);
	});
	test("builds filters and caches tool bundles without losing schemas", async () => {
		const source = {
			functionDeclarations: [
				{
					name: "Search",
					description: "Search docs",
					parameters: {
						type: "object",
						properties: { query: { type: "string" } },
					},
				},
				{
					name: "Read",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
					},
				},
			],
		};
		const bundle = createToolBundle(source);
		assert.equal(createToolBundle(bundle), bundle);
		assert.deepEqual(bundle.names, ["Search", "Read"]);
		assert.equal(bundle.schemaIndex.search.properties.query.type, "string");
		assert.equal(
			bundle.promptArtifact.toolCallInstructions(),
			bundle.promptArtifact.toolCallInstructions(),
		);
		const block = bundle.promptArtifact.inlinePromptBlock("must call Read");
		assert.equal(
			block,
			bundle.promptArtifact.inlinePromptBlock("must call Read"),
		);
		assert.match(block, /must call Read/);
		const transcript = bundle.promptArtifact.contextTranscript(
			"must call Read",
			"bundle-tools.txt",
		);
		assert.equal(
			transcript,
			bundle.promptArtifact.contextTranscript(
				"must call Read",
				"bundle-tools.txt",
			),
		);
		assert.match(transcript, /# bundle-tools\.txt/);

		const filtered = filterToolBundleByPolicy(bundle, {
			mode: "forced",
			allowed: { Read: true },
			hasAllowed: true,
		});
		assert.deepEqual(filtered.names, ["Read"]);
		assert.equal(filtered.schemaIndex.read.properties.path.type, "string");
		assert.equal(nullableOpenAIFunctionTools(filtered).length, 1);
		assert.equal(
			nullableOpenAIFunctionTools(
				filterToolBundleByPolicy(bundle, { mode: "none" }),
			),
			null,
		);
		assert.equal(
			nullableOpenAIFunctionTools(
				filterToolBundleByPolicy(bundle, {
					allowed: { Missing: true },
					hasAllowed: true,
				}),
			),
			null,
		);
		assert.equal(filterToolBundleByPolicy(bundle, null), bundle);

		assert.deepEqual(
			toolNamesForPromptSource(
				createToolBundle([
					{ name: "Search" },
					{ name: "Search" },
					{ name: "" },
				]),
			),
			["Search"],
		);
		assert.match(
			toolCallInstructionsFor(createToolBundle([{ name: "Search" }])),
			/<\|DSML\|tool_calls>/,
		);
		const empty = createToolBundle([{ type: "function", function: {} }]);
		assert.deepEqual(empty.names, []);
		assert.equal(empty.items.length, 1);
	});
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
	test("normalizes tool metadata across OpenAI Google and Responses aliases", async () => {
		const schema = {
			type: "object",
			properties: { query: { type: "string" } },
		};
		assert.equal(extractToolMeta(null), null);
		assert.deepEqual(
			extractToolMeta({
				type: "function",
				function: {
					name: "Search",
					description: "Search docs",
					parameters: schema,
				},
			}),
			{
				name: "Search",
				description: "Search docs",
				parameters: schema,
			},
		);
		assert.deepEqual(
			extractToolMeta({
				tool: { name: "Wrapped", input_schema: schema },
			}),
			{
				name: "Wrapped",
				description: "",
				parameters: schema,
			},
		);

		const grouped = {
			function_declarations: [
				{
					name: "GoogleSearch",
					description: "Google style",
					inputSchema: schema,
				},
				{ name: "", parameters: schema },
				"skip",
			],
		};
		assert.deepEqual(
			toolFunctionDeclarations(grouped).map((item) => item.name),
			["GoogleSearch", ""],
		);
		assert.deepEqual(
			toolFunctionDeclarations({ functionDeclarations: {} }),
			[],
		);
		assert.deepEqual(
			toolItemsFromTools({ tools: [{ name: "List", schema }, "skip"] }).map(
				(item) => item.name,
			),
			["List"],
		);
		assert.equal(toolItemsFromTools({ nope: true }).length, 0);
		assert.deepEqual(toolMetasFromTools(grouped), [
			{
				name: "GoogleSearch",
				description: "Google style",
				parameters: schema,
			},
		]);
		assert.deepEqual(toolDefsFromTools([{ name: "NoSchema" }]), [
			{
				name: "NoSchema",
				description: "",
				parameters: {},
			},
		]);
		assert.equal(firstNonNil(null, undefined, false, "fallback"), false);
	});
	test("finalizes OpenAI text into tool calls", async () => {
		const finalized = finalizeOpenAICompletionResult(
			'<tool_calls><invoke name="Read"><parameter name="file_path">README.md</parameter></invoke></tool_calls>',
			{
				tools: createToolBundle([
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				]),
				promptToolChoice: "auto",
				structured: null,
				toolPolicy: null,
			},
		);
		assert.equal(finalized.error, undefined);
		assert.equal(finalized.toolCalls[0].function.name, "Read");
	});
	test("validates structured output schema combinators and scalar constraints", async () => {
		const requirement = {
			type: "json_schema",
			schema: {
				type: "object",
				required: ["kind", "items", "score"],
				additionalProperties: false,
				properties: {
					kind: { oneOf: [{ const: "alpha" }, { const: "beta" }] },
					tag: {
						anyOf: [
							{ type: "string", pattern: "^ok-" },
							{ type: "integer", minimum: 10 },
						],
					},
					items: {
						type: "array",
						minItems: 2,
						maxItems: 3,
						uniqueItems: true,
						items: { type: "integer" },
					},
					score: {
						type: "number",
						exclusiveMinimum: 0,
						exclusiveMaximum: 10,
						multipleOf: 0.5,
					},
				},
			},
		};
		assert.equal(
			validateStructuredOutputValue(
				{ kind: "alpha", tag: "ok-ready", items: [1, 2], score: 1.5 },
				requirement,
			),
			"",
		);
		assert.match(
			validateStructuredOutputValue(
				{ kind: "gamma", tag: "ok-ready", items: [1, 2], score: 1.5 },
				requirement,
			),
			/oneOf/,
		);
		assert.match(
			validateStructuredOutputValue(
				{ kind: "alpha", tag: "bad", items: [1, 2], score: 1.5 },
				requirement,
			),
			/anyOf/,
		);
		assert.match(
			validateStructuredOutputValue(
				{ kind: "alpha", tag: 12, items: [1, 1], score: 1.5 },
				requirement,
			),
			/unique/,
		);
		assert.match(
			validateStructuredOutputValue(
				{ kind: "alpha", tag: 12, items: [1, 2], score: 1.3 },
				requirement,
			),
			/multiple/,
		);
		assert.match(
			validateStructuredOutputValue(
				{ kind: "alpha", tag: 12, items: [1, 2], score: 1.5, extra: true },
				requirement,
			),
			/not allowed/,
		);
	});
	test("validates structured output object array and type edge cases", async () => {
		assert.equal(
			validateStructuredOutputValue("nope", { type: "json_object" }),
			"structured output must be a JSON object",
		);
		assert.equal(
			validateStructuredOutputValue(
				{ a: "x", b: 2 },
				{
					type: "json_schema",
					schema: {
						type: "object",
						minProperties: 2,
						maxProperties: 2,
						properties: { a: { type: "string" } },
						additionalProperties: { type: "integer" },
					},
				},
			),
			"",
		);
		assert.match(
			validateStructuredOutputValue(
				{ a: "x" },
				{
					type: "json_schema",
					schema: { type: "object", minProperties: 2 },
				},
			),
			/at least 2 properties/,
		);
		assert.match(
			validateStructuredOutputValue(
				{ a: "x", b: 2, c: 3 },
				{
					type: "json_schema",
					schema: { type: "object", maxProperties: 2 },
				},
			),
			/at most 2 properties/,
		);
		assert.match(
			validateStructuredOutputValue(
				{ a: "x", b: "bad" },
				{
					type: "json_schema",
					schema: {
						type: "object",
						properties: { a: { type: "string" } },
						additionalProperties: { type: "integer" },
					},
				},
			),
			/\.b must be integer/,
		);
		assert.match(
			validateStructuredOutputValue([1, "two", true], {
				type: "json_schema",
				schema: {
					type: "array",
					items: [{ type: "integer" }, { type: "string" }],
					additionalItems: false,
				},
			}),
			/additional array items/,
		);
		assert.equal(
			validateStructuredOutputValue(2, {
				type: "json_schema",
				schema: { type: ["string", "integer"] },
			}),
			"",
		);
		assert.equal(
			validateStructuredOutputValue(
				{ maybe: null },
				{
					type: "json_schema",
					schema: {
						type: "object",
						properties: { maybe: { type: "string", nullable: true } },
					},
				},
			),
			"",
		);
		assert.match(
			validateStructuredOutputValue(
				{ maybe: null },
				{
					type: "json_schema",
					schema: {
						type: "object",
						properties: { maybe: { type: "string" } },
					},
				},
			),
			/\.maybe must be string, got null/,
		);
		assert.match(
			validateStructuredOutputValue("abcd", {
				type: "json_schema",
				schema: { type: "string", minLength: 2, maxLength: 3 },
			}),
			/at most 3/,
		);
		assert.equal(
			validateStructuredOutputValue("anything", {
				type: "json_schema",
				schema: { type: "string", pattern: "[" },
			}),
			"",
		);
		assert.match(
			validateStructuredOutputValue(1, {
				type: "json_schema",
				schema: { oneOf: [{ type: "number" }, { type: "integer" }] },
			}),
			/matched 2/,
		);
	});
	test("builds and finalizes structured output requirements from noisy JSON text", async () => {
		assert.equal(
			getStructuredResponseFormat({
				text: { format: { type: "json_object" } },
			}).type,
			"json_object",
		);
		assert.equal(getStructuredResponseFormat(null), null);
		assert.equal(buildStructuredOutputRequirement({}), null);
		assert.equal(
			buildStructuredOutputRequirement({ type: "unsupported" }),
			null,
		);
		const defaultedRequirement = buildStructuredOutputRequirement({
			type: "json_schema",
			name: " ",
			schema: { type: "object" },
		});
		assert.match(defaultedRequirement.instruction, /Schema name: response/);
		assert.match(defaultedRequirement.instruction, /Strict mode: true/);
		assert.equal(canonicalizeStructuredOutputText(" raw ", null), " raw ");
		assert.equal(validateStructuredOutputValue({}, null), "");
		assert.equal(
			buildStructuredOutputRequirement({
				type: "json_schema",
				json_schema: { name: "bad" },
			}).error,
			"response_format json_schema requires a schema object",
		);
		const cyclic = {};
		cyclic.self = cyclic;
		assert.equal(
			buildStructuredOutputRequirement({
				type: "json_schema",
				json_schema: { schema: cyclic },
			}).error,
			"response_format json_schema schema must be JSON serializable",
		);
		const requirement = buildStructuredOutputRequirement({
			type: "json_schema",
			name: "loose_result",
			strict: false,
			schema: { type: "object", properties: { ok: { type: "boolean" } } },
		});
		assert.match(requirement.instruction, /Schema name: loose_result/);
		assert.match(requirement.instruction, /Strict mode: false/);
		assert.equal(
			extractFirstJsonDocument('prefix [1,{"a":"}"}] suffix'),
			'[1,{"a":"}"}]',
		);
		assert.equal(
			extractFirstJsonDocument('prefix [{"ok":true} } suffix'),
			'{"ok":true}',
		);
		assert.equal(extractFirstJsonDocument('prefix {"a":] suffix'), "");
		assert.equal(extractFirstJsonDocument("{{{{"), "");
		assert.deepEqual(
			parseStructuredJsonCandidate('prefix {"ok":true} suffix'),
			{ ok: true },
		);
		assert.equal(
			parseStructuredJsonCandidate("no json here"),
			STRUCTURED_JSON_NOT_FOUND,
		);
		assert.equal(
			canonicalizeStructuredOutputText(
				'prefix {"ok":true} suffix',
				requirement,
			),
			'{"ok":true}',
		);
		assert.match(
			finalizeStructuredOutputText('prefix {"ok":true} suffix', {
				type: "json_schema",
				schema: { allOf: [{ type: "object" }, { required: ["missing"] }] },
			}).error,
			/\.missing is required/,
		);
		assert.equal(
			finalizeStructuredOutputText("not json", requirement).error,
			"structured output was not valid JSON",
		);
	});
	test("compares nested JSON values independent of object key order", async () => {
		assert.equal(
			jsonValuesEqual(
				{ a: [1, { b: true }], c: null },
				{ c: null, a: [1, { b: true }] },
			),
			true,
		);
		assert.equal(
			jsonValuesEqual({ a: [1, { b: true }] }, { a: [1, { b: false }] }),
			false,
		);
		assert.equal(jsonValuesEqual([1, 2], [2, 1]), false);
	});
	test("rejects tool calls when OpenAI tool choice is none", async () => {
		const finalized = finalizeOpenAICompletionResult(
			'<tool_calls><invoke name="Read"><parameter name="file_path">README.md</parameter></invoke></tool_calls>',
			{
				tools: null,
				noneModeTools: createToolBundle([
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				]),
				promptToolChoice: "none",
				structured: null,
				toolPolicy: {
					mode: "none",
					forcedName: "",
					allowed: {},
					hasAllowed: true,
					declared: ["Read"],
					error: "",
				},
			},
		);
		assert.equal(finalized.error.code, "tool_choice_violation");
		assert.equal(finalized.error.status, 422);
	});
	test("streams OpenAI tool choice violation and DONE marker", async () => {
		const writes = [];
		await streamOpenAIChatWithToolSieve(
			(chunk) => writes.push(chunk),
			{},
			{
				provider: fakeStreamProvider([
					'<tool_calls><invoke name="Read"><parameter name="file_path">README.md</parameter></invoke></tool_calls>',
				]),
				id: "chatcmpl_test",
				model: "gemini-3.5-flash",
				prompt: "do not call tools",
				rm: { name: "gemini-3.5-flash" },
				fileRefs: null,
				tools: createToolBundle([
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				]),
				toolPolicy: {
					mode: "none",
					forcedName: "",
					allowed: {},
					hasAllowed: true,
					declared: ["Read"],
					error: "",
				},
				includeUsage: false,
				promptTokens: 1,
				signal: new AbortController().signal,
			},
		);
		const body = writes.join("");
		assert.match(body, /tool_choice does not allow tool\(s\): Read/);
		assert.match(body, /data: \[DONE\]/);
	});
	test("streams Responses failure for missing required tool call", async () => {
		const writes = [];
		await streamResponsesWithToolSieve(
			(chunk) => writes.push(chunk),
			{},
			{
				provider: fakeStreamProvider(["plain answer"]),
				rid: "resp_test",
				rm: { name: "gemini-3.5-flash" },
				prompt: "must call a tool",
				fileRefs: null,
				tools: createToolBundle([
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				]),
				toolPolicy: {
					mode: "required",
					forcedName: "",
					allowed: null,
					hasAllowed: false,
					declared: ["Read"],
					error: "",
				},
				promptTokens: 1,
				signal: new AbortController().signal,
			},
		);
		const body = writes.join("");
		assert.match(body, /event: response.failed/);
		assert.match(body, /tool_choice requires at least one valid tool call/);
	});
	test("moves large tool context into attached tools file", async () => {
		const cfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 10,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "SID=ok",
			supports_authenticated_session: true,
			log_requests: false,
		};
		const uploads = [];
		const result = await prepareContextFilesWithUploader(
			cfg,
			"user history with latest request",
			[
				{
					name: "Read",
					description: "Read a file",
					parameters: { type: "object" },
				},
			],
			"must call Read",
			"latest request",
			"x".repeat(40),
			async (text, filename) => {
				uploads.push({ text, filename });
				return { ref: `/uploaded/${filename}`, name: filename };
			},
		);
		assert.equal(result.error, undefined);
		assert.equal(result.fileRefs.length, 2);
		assert.equal(uploads[0].filename, "message.txt");
		assert.equal(uploads[1].filename, "tools.txt");
		assert.match(
			result.prompt,
			/Continue from the latest state in the attached `message\.txt` context/,
		);
		assert.match(
			result.prompt,
			/All text above this sentence is system prompt content/,
		);
		assert.doesNotMatch(result.prompt, /<\|DSML\|tool_calls>/);
		assert.doesNotMatch(result.prompt, /must call Read/);
		assert.doesNotMatch(result.prompt, /Gemini native hidden tool calls/);
		assert.match(uploads[1].text, /Available tool descriptions/);
		assert.match(uploads[1].text, /Tool call format instructions/);
		assert.match(uploads[1].text, /<\|DSML\|tool_calls>/);
		assert.match(uploads[1].text, /Tool choice policy:\nmust call Read/);
		assert.match(uploads[1].text, /Gemini native hidden tool calls/);
		assert.match(uploads[1].text, /All of the above is system prompt content/);
		assert.match(result.promptTokenText, /user history/);
		assert.match(result.promptTokenText, /Available tool descriptions/);
		assert.match(result.promptTokenText, /Gemini native hidden tool calls/);
	});
	test("keeps hidden native tool prompt separate from DSML instructions", async () => {
		const cfg = {
			current_input_file_enabled: false,
			current_input_file_min_bytes: 1000000,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "",
			log_requests: false,
		};
		const result = await prepareOpenAIGeminiContext(
			cfg,
			fakeStreamProvider([]),
			{},
			parseOpenAIMessages([{ role: "user", content: "what changed today?" }]),
			null,
			"auto",
			null,
			null,
		);
		assert.equal(result.error, undefined);
		const marker = "Gemini native hidden tool calls:";
		assert.equal(result.prompt.indexOf(marker) >= 0, true);
		assert.equal(
			result.prompt.indexOf(marker) <
				result.prompt.indexOf("what changed today?"),
			true,
		);
		const hiddenPrompt = result.prompt.slice(result.prompt.indexOf(marker));
		assert.match(hiddenPrompt, /Do not use DSML\/XML tool-call syntax/);
		assert.match(
			hiddenPrompt,
			/do not print the call schema or JSON payload directly/,
		);
		assert.match(
			hiddenPrompt,
			/internal hidden tool call, not final response text/,
		);
		assert.match(
			hiddenPrompt,
			/Internal search call payload(?:, for the hidden native tool channel only)?:\n\{\n {2}"tool_calls": \[/,
		);
		assert.match(hiddenPrompt, /"name": "google:search"/);
		assert.match(hiddenPrompt, /"arguments": "{\\"queries\\": \[/);
		assert.match(
			hiddenPrompt,
			/Internal Python call payload(?:, for the hidden native tool channel only)?:\n\{\n {2}"tool_calls": \[/,
		);
		assert.match(hiddenPrompt, /"name": "google:ds_python_interpreter"/);
		assert.match(hiddenPrompt, /"arguments": "{\\"code\\": /);
		assert.match(hiddenPrompt, /All of the above is system prompt content/);
		assert.doesNotMatch(
			hiddenPrompt,
			/top-level "tool_calls" array|function\.arguments must be a serialized JSON string|Do not wrap the payload in markdown fences|<\|DSML\|tool_calls>|<tool_calls>|<invoke\b|<parameter\b|"google:search": \[/,
		);
	});
	test("normalizes Responses-style tools and nested XML arguments", async () => {
		const cfg = {
			current_input_file_enabled: false,
			current_input_file_min_bytes: 1000000,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "",
			log_requests: false,
		};
		const tools = [
			{
				type: "function",
				name: "Search",
				description: "Search documents",
				input_schema: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			},
		];
		const result = await prepareOpenAIGeminiContext(
			cfg,
			fakeStreamProvider([]),
			{},
			parseOpenAIMessages([{ role: "user", content: "find docs" }]),
			createToolBundle(tools),
			"required",
			{
				mode: "required",
				forcedName: "",
				allowed: null,
				hasAllowed: false,
				declared: ["Search"],
				error: "",
			},
			null,
		);
		assert.equal(result.error, undefined);
		assert.match(result.prompt, /Available tools/);
		assert.match(result.prompt, /"name": "Search"/);
		assert.match(result.prompt, /"query"/);
		assert.equal(
			result.prompt.indexOf("<|DSML|tool_calls>") <
				result.prompt.indexOf("Gemini native hidden tool calls:"),
			true,
		);
		assert.equal(
			result.prompt.indexOf("Gemini native hidden tool calls:") <
				result.prompt.indexOf("find docs"),
			true,
		);
		assert.equal(
			(result.prompt.match(/Gemini native hidden tool calls:/g) || []).length,
			1,
		);

		const finalized = finalizeOpenAICompletionResult(
			'<tool_calls><invoke name="Search"><parameter name="query"><term>docs</term></parameter></invoke></tool_calls>',
			{
				tools: createToolBundle(tools),
				promptToolChoice: "required",
				structured: null,
				toolPolicy: {
					mode: "required",
					forcedName: "",
					allowed: null,
					hasAllowed: false,
					declared: ["Search"],
					error: "",
				},
			},
		);
		assert.equal(finalized.error, undefined);
		const args = JSON.parse(finalized.toolCalls[0].function.arguments);
		assert.equal(args.query, '{"term":"docs"}');
	});
	test("accepts OpenAI tool schema aliases", async () => {
		for (const key of ["input_schema", "inputSchema", "schema"]) {
			const schema = {
				type: "object",
				properties: { value: { type: "string" } },
			};
			const defs = createToolBundle([
				{ type: "function", name: `Alias_${key}`, [key]: schema },
			]).promptArtifact.defs;
			assert.equal(defs[0].name, `Alias_${key}`);
			assert.deepEqual(defs[0].parameters, schema);
		}
	});
	test("formats prompt tool-call parameters with XML-safe fallbacks", async () => {
		const block = formatPromptToolCallBlock('Run"Now', {
			text: "a]]>b",
			shape: {
				valid_name: true,
				"bad key": ["x", null, 2, false, undefined],
			},
			empty: undefined,
		});
		assert.match(block, /<\|DSML\|invoke name="Run&quot;Now">/);
		assert.match(
			block,
			/<\|DSML\|parameter name="text"><!\[CDATA\[a\]\]\]\]><!\[CDATA\[>b\]\]><\/\|DSML\|parameter>/,
		);
		assert.match(block, /<valid_name>true<\/valid_name>/);
		assert.match(
			block,
			/<field name="bad key"><item><!\[CDATA\[x\]\]><\/item><item>null<\/item><item>2<\/item><item>false<\/item><item><\/item><\/field>/,
		);
		assert.match(
			block,
			/<\|DSML\|parameter name="empty"><\/\|DSML\|parameter>/,
		);
		assert.equal(isSafeXmlElementName("a.b-c_1"), true);
		assert.equal(isSafeXmlElementName("1bad"), false);
		assert.equal(formatPromptParamValue(Symbol("skip")), "");
	});
	test("formats OpenAI tool call payloads and prompt XML helper edges", async () => {
		assert.deepEqual(formatOpenAIToolCalls(null, null), []);
		assert.deepEqual(formatOpenAIStreamToolCalls([], new Map(), null), []);

		const tools = [
			{
				type: "function",
				function: {
					name: "Lookup",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string" },
							count: { type: "integer" },
						},
					},
				},
			},
		];
		const bundle = createToolBundle(tools);
		const calls = [
			{ name: "Lookup", input: { query: { term: "docs" }, count: "3" } },
			{ name: "NoInput" },
		];
		const formatted = formatOpenAIToolCalls(calls, bundle);
		assert.equal(formatted.length, 2);
		assert.match(formatted[0].id, /^call_[0-9a-f]{8}$/);
		assert.equal(formatted[0].type, "function");
		assert.deepEqual(JSON.parse(formatted[0].function.arguments), {
			query: '{"term":"docs"}',
			count: "3",
		});
		assert.deepEqual(JSON.parse(formatted[1].function.arguments), {});
		assert.equal("index" in formatted[0], false);

		const ids = new Map();
		const streamCalls = formatOpenAIStreamToolCalls(calls, ids, bundle);
		assert.equal(streamCalls[0].index, 0);
		assert.match(streamCalls[0].id, /^call_[0-9a-f]{32}$/);
		assert.equal(ensureStreamToolCallID(ids, 0), streamCalls[0].id);
		const fallbackId = ensureStreamToolCallID(null, 0);
		assert.match(fallbackId, /^call_[0-9a-f]{32}$/);
		const nonIntegerId = ensureStreamToolCallID(ids, "not-an-index");
		assert.equal(nonIntegerId, streamCalls[0].id);

		assert.equal(promptCDATA(""), "");
		assert.equal(promptCDATA("a]]>b"), "<![CDATA[a]]]]><![CDATA[>b]]>");
		assert.equal(xmlEscapeAttr(null), "");
		assert.equal(xmlEscapeAttr('a&"<>'), "a&amp;&quot;&lt;&gt;");
		assert.equal(
			indentPromptParameters("", "  "),
			'  <|DSML|parameter name="content"></|DSML|parameter>',
		);
		assert.equal(
			indentPromptParameters("one\n\n two", "  "),
			"  one\n\n   two",
		);
		assert.equal(
			wrapParameter('bad"&<>', "value"),
			'<|DSML|parameter name="bad&quot;&amp;&lt;&gt;">value</|DSML|parameter>',
		);
	});
	test("parses XML helper edges for nested tags CDATA and malformed markup", async () => {
		assert.equal(decodeCDATA("<![CDATA[open"), "open");
		assert.equal(decodeCDATA("<![CDATA[a]]><![CDATA[>b]]>"), "a>b");
		assert.equal(
			decodeXmlEntities("&lt;a x=&quot;1&quot; y=&apos;2&apos;&gt;&amp;"),
			"<a x=\"1\" y='2'>&",
		);

		const values = { a: 1 };
		appendMarkupValue(values, "a", 2);
		appendMarkupValue(values, "a", 3);
		appendMarkupValue(values, "b", "one");
		assert.deepEqual(values, { a: [1, 2, 3], b: "one" });

		assert.deepEqual(
			parseTagAttributes('a="1&amp;2" b=\'two\' c=bare d="x>y" a=ignored'),
			{
				a: "1&2",
				b: "two",
				c: "bare",
				d: "x>y",
			},
		);

		const nested =
			'ignore <![CDATA[<item>skip</item>]]><item id="1"><item/>body</item><item>two</item><item>broken';
		const blocks = findXmlElementBlocks(nested, "item");
		assert.equal(blocks.length, 2);
		assert.equal(blocks[0].attrs.trim(), 'id="1"');
		assert.equal(blocks[0].body, "<item/>body");
		assert.equal(blocks[1].body, "two");
		assert.deepEqual(findXmlElementBlocks("<item>unterminated", "item"), []);

		const top = findTopLevelXmlElementBlocks(
			"<root><child>1</child></root><solo/>",
		);
		assert.deepEqual(
			top.map((block) => block.name),
			["root", "solo"],
		);
		assert.equal(top[1].body, "");
		assert.deepEqual(findTopLevelXmlElementBlocks("leading <root></root>"), []);
		assert.deepEqual(
			findTopLevelXmlElementBlocks("<root><child></root> trailing"),
			[],
		);

		assert.equal(findNextXmlTag("<a></a>", "a", 0, false).closing, false);
		assert.equal(findNextXmlTag("<a></a>", "a", 0, true).closing, true);
		assert.equal(findNextXmlTag("<a></a>", "b", 0, null), null);
		assert.equal(
			findNextAnyXmlTag("x <![CDATA[<a>]]> <b/>", 0, false).name,
			"b",
		);
		assert.equal(skipCDATAAt("<![CDATA[x]]><a>", 0), 13);
		assert.equal(skipCDATAAt("plain", 0), 0);

		assert.equal(scanXmlTagAt("x<a>", 0), null);
		assert.equal(scanXmlTagAt("<1bad>", 0), null);
		assert.equal(
			scanXmlTagAt('<bad:name attr="x>y">', 0).attrs.trim(),
			'attr="x>y"',
		);
		assert.equal(scanXmlTagAt('<bad:name attr="unterminated>', 0), null);
		assert.equal(findXmlTagEnd('<a x="y>z"', 3), -1);
	});
	test("normalizes parsed tool-call arguments through schema aliases", async () => {
		const tools = [
			{
				type: "function",
				function: {
					name: "Lookup",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string" },
							maybe: { type: ["string", "null"] },
							choices: {
								type: "array",
								items: [
									{ type: "string" },
									{
										type: "object",
										additionalProperties: { type: "string" },
									},
								],
							},
						},
						additionalProperties: { type: "string" },
					},
				},
			},
		];
		const calls = [
			{
				name: "Lookup",
				input: {
					query: { term: "docs" },
					maybe: 5,
					choices: [7, { a: 1 }, false],
					extra: true,
				},
			},
			"not a call",
			{ name: "Missing", input: { query: { term: "unchanged" } } },
			{ name: "Lookup", input: "not an object" },
		];
		const normalized = normalizeParsedToolCallsForSchemas(
			calls,
			createToolBundle(tools),
		);
		assert.equal(normalized[0].input.query, '{"term":"docs"}');
		assert.equal(normalized[0].input.maybe, "5");
		assert.deepEqual(normalized[0].input.choices, ["7", { a: "1" }, false]);
		assert.equal(normalized[0].input.extra, "true");
		assert.equal(normalized[1], "not a call");
		assert.deepEqual(normalized[2], calls[2]);
		assert.deepEqual(normalized[3], calls[3]);
		assert.deepEqual(
			buildToolSchemaIndex(createToolBundle(tools)).lookup,
			tools[0].function.parameters,
		);
	});
	test("keeps schema normalization conservative when no conversion is required", async () => {
		assert.deepEqual(normalizeParsedToolCallsForSchemas(null, null), null);
		assert.deepEqual(normalizeParsedToolCallsForSchemas([], null), []);
		assert.deepEqual(normalizeToolValueWithSchema(null, { type: "string" }), [
			null,
			false,
		]);
		assert.deepEqual(normalizeToolValueWithSchema({ a: 1 }, null), [
			{ a: 1 },
			false,
		]);
		assert.deepEqual(
			normalizeToolValueWithSchema([], {
				type: "array",
				items: { type: "string" },
			}),
			[[], false],
		);
		assert.deepEqual(
			normalizeToolValueWithSchema(["x"], {
				type: "array",
				items: [null],
			}),
			[["x"], false],
		);
		assert.equal(shouldCoerceSchemaToString({ const: "fixed" }), true);
		assert.equal(shouldCoerceSchemaToString({ enum: ["a", "b"] }), true);
		assert.equal(
			shouldCoerceSchemaToString({ type: ["string", "null"] }),
			true,
		);
		assert.equal(
			shouldCoerceSchemaToString({ type: ["string", "integer"] }),
			false,
		);
		assert.equal(looksLikeObjectSchema({ properties: {} }), true);
		assert.equal(looksLikeArraySchema({ items: {} }), true);
		const cyclic = {};
		cyclic.self = cyclic;
		assert.deepEqual(stringifySchemaValue(cyclic), [cyclic, false]);
	});
	test("accepts wrapped OpenAI tool definitions in tool choice policy", async () => {
		const schema = {
			type: "object",
			properties: { query: { type: "string" } },
		};
		const defs = createToolBundle([
			{
				type: "function",
				tool: {
					name: "WrappedSearch",
					description: "Search docs",
					input_schema: schema,
				},
			},
		]).promptArtifact.defs;
		assert.equal(defs[0].name, "WrappedSearch");
		assert.equal(defs[0].description, "Search docs");
		assert.deepEqual(defs[0].parameters, schema);
		const policy = parseOpenAIToolChoicePolicy(
			{ type: "function", name: "WrappedSearch" },
			createToolBundle([
				{
					type: "function",
					tool: { name: "WrappedSearch", input_schema: schema },
				},
			]),
		);
		assert.equal(policy.error, "");
		assert.equal(policy.forcedName, "WrappedSearch");
	});
	test("parses OpenAI allowed_tools policy aliases and filters duplicates", async () => {
		const tools = createToolBundle([
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
			{
				type: "function",
				function: { name: "Search", parameters: { type: "object" } },
			},
		]);
		const policy = parseOpenAIToolChoicePolicy(
			{
				type: "allowed_tools",
				mode: "required",
				tools: [
					"Read",
					{ function: { name: "Search" } },
					{ tool: { name: "Read" } },
				],
			},
			tools,
		);
		assert.equal(policy.error, "");
		assert.equal(policy.mode, "required");
		assert.deepEqual(Object.keys(policy.allowed), ["Read", "Search"]);
	});
	test("reports OpenAI tool choice shape errors without changing policy mode", async () => {
		const tools = createToolBundle([
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.match(
			parseOpenAIToolChoicePolicy(42, tools).error,
			/must be a string or object/,
		);
		assert.match(
			parseOpenAIToolChoicePolicy("sometimes", tools).error,
			/unsupported tool_choice/,
		);
		assert.match(
			parseOpenAIToolChoicePolicy(
				{ type: "allowed_tools", mode: "always", tools: ["Read"] },
				tools,
			).error,
			/unsupported tool_choice\.mode/,
		);
		assert.match(
			parseOpenAIToolChoicePolicy({ type: "allowed_tools", tools: [{}] }, tools)
				.error,
			/did not contain any valid tool names/,
		);
		assert.match(
			parseOpenAIToolChoicePolicy(
				{ type: "function", function: { name: "Missing" } },
				tools,
			).error,
			/forced tool is not declared/,
		);
		assert.match(
			parseOpenAIToolChoicePolicy({ type: "function" }, tools).error,
			/requires function\.name/,
		);
	});
	test("covers OpenAI tool choice policy helper edge cases", async () => {
		const tools = [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
			{
				type: "function",
				function: { name: "Search", parameters: { type: "object" } },
			},
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		];
		const toolsBundle = createToolBundle(tools);
		const googleGroup = {
			functionDeclarations: [{ name: "Lookup" }, { name: "Read" }],
		};
		assert.deepEqual(extractToolNames(toolsBundle), ["Read", "Search"]);
		assert.deepEqual(extractToolNames(createToolBundle(googleGroup)), [
			"Lookup",
			"Read",
		]);
		assert.deepEqual(extractToolNames(createToolBundle(tools)), [
			"Read",
			"Search",
		]);
		assert.deepEqual(namesToSet(["Read", "", null, "Search"]), {
			Read: true,
			Search: true,
		});
		assert.equal(allowedToolNameFromItem(" Read "), " Read ");
		assert.equal(
			allowedToolNameFromItem({ function: { name: "Search" } }),
			"Search",
		);
		assert.equal(
			allowedToolNameFromItem({ tool: { name: "Lookup" } }),
			"Lookup",
		);
		assert.equal(allowedToolNameFromItem(5), "");

		assert.equal(parseAllowedToolNames(null), null);
		assert.deepEqual(parseAllowedToolNames("Read, Search"), {
			names: ["Read", "Search"],
		});
		assert.deepEqual(
			parseAllowedToolNames({
				allowed_tools: [
					{ function: { name: "Read" } },
					{ tool: { name: "Search" } },
					"Read",
				],
			}),
			{ names: ["Read", "Search"] },
		);
		assert.match(parseAllowedToolNames([]).error, /non-empty array/);
		assert.match(
			parseAllowedToolNames([{}]).error,
			/did not contain any valid tool names/,
		);
		assert.equal(parseForcedToolName({ name: "Read" }), "Read");
		assert.equal(
			parseForcedToolName({ function: { name: "Search" } }),
			"Search",
		);
		assert.equal(parseForcedToolName("Read"), "");

		const forcedAuto = parseOpenAIToolChoicePolicy(
			{ type: "auto", name: "Read" },
			toolsBundle,
		);
		assert.equal(forcedAuto.mode, "forced");
		assert.deepEqual(forcedAuto.allowed, { Read: true });
		const noneObject = parseOpenAIToolChoicePolicy(
			{ type: "none" },
			toolsBundle,
		);
		assert.equal(noneObject.mode, "none");
		assert.deepEqual(noneObject.allowed, {});
		assert.match(
			parseOpenAIToolChoicePolicy({ type: "required" }, null).error,
			/requires at least one tool/,
		);
		assert.match(
			parseOpenAIToolChoicePolicy({ allowed_tools: ["Missing"] }, toolsBundle)
				.error,
			/allowed unknown tool/,
		);

		assert.equal(policyHasAllowed(null), false);
		assert.equal(policyHasAllowed({ allowed: {}, hasAllowed: false }), false);
		assert.equal(
			policyHasAllowed({ allowed: { Read: true }, hasAllowed: false }),
			true,
		);
		assert.equal(toolPolicyAllows(null, "Anything"), true);
		assert.equal(toolPolicyAllows(noneObject, "Read"), false);
		assert.equal(toolPolicyAllows(forcedAuto, "Read"), true);
		assert.equal(toolPolicyAllows(forcedAuto, "Search"), false);

		assert.equal(filterToolsByPolicy(null, forcedAuto), null);
		assert.equal(filterToolsByPolicy(toolsBundle, { mode: "none" }), null);
		assert.equal(
			filterToolsByPolicy(toolsBundle, null),
			toolsBundle.openAIFunctionTools,
		);
		assert.deepEqual(
			filterToolsByPolicy(toolsBundle, forcedAuto).map(
				(tool) => tool.function.name,
			),
			["Read", "Read"],
		);
		assert.deepEqual(
			filterToolsByPolicy(createToolBundle(tools), forcedAuto).map(
				(tool) => tool.function.name,
			),
			["Read", "Read"],
		);

		assert.equal(buildToolChoiceInstructionFromPolicy(null), "");
		assert.equal(buildToolChoiceInstructionFromPolicy({ mode: "auto" }), "");
		assert.match(
			buildToolChoiceInstructionFromPolicy(noneObject),
			/Do NOT call any tools/,
		);
		assert.match(
			buildToolChoiceInstructionFromPolicy(forcedAuto),
			/MUST call the tool "Read"/,
		);
		assert.match(
			buildToolChoiceInstructionFromPolicy({
				mode: "required",
				allowed: { Read: true, Search: true },
			}),
			/"Read", "Search"/,
		);
		assert.match(
			buildToolChoiceInstructionFromPolicy({
				mode: "required",
				allowed: null,
			}),
			/MUST call at least one tool/,
		);

		const required = {
			mode: "required",
			allowed: { Read: true },
			hasAllowed: true,
		};
		assert.equal(validateRequiredToolCalls(null, []), null);
		assert.match(
			validateRequiredToolCalls(required, []).message,
			/requires at least one valid tool call/,
		);
		assert.match(
			validateRequiredToolCalls(required, [
				{ function: { name: "Search" } },
				{ name: "Search" },
			]).message,
			/Search/,
		);
		const forcedMissing = validateRequiredToolCalls(forcedAuto, [
			{ function: { name: "" } },
		]);
		assert.match(forcedMissing.message, /requires the tool Read/);
		assert.equal(
			validateRequiredToolCalls(forcedAuto, [{ name: "Read" }]),
			null,
		);
		assert.deepEqual(
			validateToolPolicyCalls(forcedAuto, [], {
				requiredMessage: "need call",
				badMessage: (names) => `bad ${names}`,
				forcedMessage: (name) => `missing ${name}`,
			}),
			{ message: "need call", code: "tool_choice_violation" },
		);
	});
	test("uses fallback tool defs when prompt source has no tools", async () => {
		const result = messagesToPrompt(
			parseOpenAIMessages([{ role: "user", content: "find docs" }]),
			{
				bundle: createToolBundle([
					{
						name: "Search",
						description: "Search docs",
						parameters: {
							type: "object",
							properties: { query: { type: "string" } },
						},
					},
				]),
				choiceInstruction: "",
				include: true,
			},
			1000000,
		);
		assert.match(result.text, /Available tools/);
		assert.match(result.text, /"name": "Search"/);
		assert.match(result.text, /"query"/);
		assert.doesNotMatch(result.text, /Gemini native hidden tool calls/);
	});
});
