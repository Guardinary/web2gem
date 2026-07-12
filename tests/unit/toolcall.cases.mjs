import { assert } from "./assertions.js";
import { fakeStreamProvider, mod } from "./helpers.js";

export const suiteName = "toolcall";
export const cases = [
	[
		"parses long plain text without tool calls",
		async () => {
			const plain = "plain text without tool syntax\n".repeat(8000);
			const [clean, toolCalls] = mod.parseToolCalls(plain, [
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			]);
			assert.equal(clean, plain.trim());
			assert.deepEqual(toolCalls, []);
		},
	],
	[
		"avoids expensive parsing for markup false positives",
		async () => {
			const falsePositive =
				"a < b and parameterless prose should stay plain\n".repeat(5000);
			assert.equal(mod.hasToolCallMarkupSyntaxCandidate(falsePositive), false);
			assert.equal(mod.findToolCallSyntaxCandidateStart(falsePositive), -1);
			const [clean, toolCalls] = mod.parseToolCalls(falsePositive, [
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			]);
			assert.equal(clean, falsePositive.trim());
			assert.deepEqual(toolCalls, []);
		},
	],
	[
		"releases partial DSML sentinel when it becomes plain text",
		async () => {
			assert.equal(mod.isPartialToolCallSyntaxPrefix("<|DS"), true);
			const state = mod.createToolSieveState();
			const emitted = mod.processToolSieveChunk(state, "hello <|DS");
			assert.deepEqual(emitted, ["hello "]);
			assert.equal(state.buffer, "<|DS");
			assert.equal(state.holdingToolCandidate, true);
			const released = mod.processToolSieveChunk(
				state,
				" but this is not a tool tag",
			);
			assert.deepEqual(released, ["<|DS but this is not a tool tag"]);
			assert.equal(state.buffer, "");
			assert.equal(state.holdingToolCandidate, false);
		},
	],
	[
		"keeps bounded plain text tail in tool sieve state",
		async () => {
			const state = mod.createToolSieveState();
			const text = `a < b and parameterless prose ${"x".repeat(300)}`;
			const emitted = mod.processToolSieveChunk(state, text);
			assert.equal(emitted.join("").length > 0, true);
			assert.equal(state.buffer.length <= 64, true);
			const flushed = mod.flushToolSieve(state, null);
			assert.equal(emitted.join("") + flushed.text, text);
			assert.equal(flushed.toolCalls, null);
		},
	],
	[
		"covers tool sieve helper state edges",
		async () => {
			assert.equal(mod.hasToolSieveSentinel("plain text"), false);
			assert.equal(mod.hasToolSieveSentinel("before <tool_calls>"), true);
			assert.equal(mod.hasToolCallCloseSyntax("</tool_calls>"), true);
			assert.equal(mod.flushToolSievePlainPrefix(null), null);

			const holding = {
				buffer: "x".repeat(100),
				holdingToolCandidate: true,
				sawToolClose: false,
				parsedToolCandidate: false,
			};
			assert.equal(mod.flushToolSievePlainPrefix(holding), null);
			assert.equal(holding.buffer.length, 100);

			const sentinel = {
				buffer: "plain <tool_calls>",
				holdingToolCandidate: false,
				sawToolClose: false,
				parsedToolCandidate: false,
			};
			assert.equal(mod.flushToolSievePlainPrefix(sentinel), null);

			const plain = {
				buffer: "p".repeat(100),
				holdingToolCandidate: false,
				sawToolClose: false,
				parsedToolCandidate: false,
			};
			const flushedPlain = mod.flushToolSievePlainPrefix(plain);
			assert.deepEqual(flushedPlain, [
				"p".repeat(100 - mod.TOOL_SIEVE_PLAIN_TEXT_KEEP),
			]);
			assert.equal(plain.buffer.length, mod.TOOL_SIEVE_PLAIN_TEXT_KEEP);

			const parsed = {
				buffer: '<tool_calls><invoke name="Read"></invoke></tool_calls>',
				holdingToolCandidate: true,
				sawToolClose: true,
				parsedToolCandidate: true,
			};
			assert.deepEqual(mod.processToolSieveChunk(parsed, ""), []);
			assert.equal(parsed.buffer.includes("<tool_calls>"), true);

			const malformedHeld = {
				buffer: "<tool_calls><invoke></invoke></tool_calls>",
				holdingToolCandidate: true,
				sawToolClose: true,
				parsedToolCandidate: false,
			};
			assert.deepEqual(mod.processToolSieveChunk(malformedHeld, ""), []);
			assert.equal(malformedHeld.buffer.includes("<tool_calls>"), true);

			const malformed = {
				buffer: "</tool_calls>",
				holdingToolCandidate: true,
				sawToolClose: true,
				parsedToolCandidate: false,
			};
			assert.deepEqual(mod.processToolSieveChunk(malformed, ""), []);
			assert.equal(malformed.buffer, "</tool_calls>");
			assert.equal(malformed.holdingToolCandidate, true);

			assert.deepEqual(mod.flushToolSieve(null, []), {
				text: "",
				toolCalls: null,
			});
			assert.deepEqual(
				mod.flushToolSieve(
					{
						buffer: "plain",
						holdingToolCandidate: false,
						sawToolClose: false,
						parsedToolCandidate: false,
					},
					[],
				),
				{
					text: "plain",
					toolCalls: null,
				},
			);
		},
	],
	[
		"holds complete DSML candidates until flush without leaking text",
		async () => {
			const chunkedState = mod.createToolSieveState();
			const partialCandidate =
				'<|DSML|tool_calls><|DSML|invoke name="Read"><|DSML|parameter name="path">';
			assert.deepEqual(
				mod.processToolSieveChunk(chunkedState, partialCandidate.slice(0, 32)),
				[],
			);
			assert.deepEqual(
				mod.processToolSieveChunk(chunkedState, partialCandidate.slice(32)),
				[],
			);
			assert.equal(chunkedState.heldLength, partialCandidate.length);
			assert.equal(chunkedState.heldLength > chunkedState.buffer.length, true);

			const state = mod.createToolSieveState();
			const candidate =
				'<|DSML|tool_calls><|DSML|invoke name="Read"><|DSML|parameter name="path"><![CDATA[README.md]]></|DSML|parameter></|DSML|invoke></|DSML|tool_calls>';
			assert.deepEqual(
				mod.processToolSieveChunk(state, candidate.slice(0, 32)),
				[],
			);
			assert.deepEqual(
				mod.processToolSieveChunk(state, candidate.slice(32)),
				[],
			);
			assert.equal(state.parsedToolCandidateResult.calls[0].name, "Read");
			assert.equal(state.parsedToolCandidateLength, candidate.length);
			const flushed = mod.flushToolSieve(state, [
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			]);
			assert.equal(flushed.toolCalls[0].function.name, "Read");
			assert.match(flushed.toolCalls[0].function.arguments, /README\.md/);
		},
	],
	[
		"reparses cached tool candidates when more text arrives before flush",
		async () => {
			const state = mod.createToolSieveState();
			const candidate =
				'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>';
			assert.deepEqual(
				mod.processToolSieveChunk(state, candidate.slice(0, 32)),
				[],
			);
			assert.deepEqual(
				mod.processToolSieveChunk(state, candidate.slice(32)),
				[],
			);
			assert.equal(state.parsedToolCandidateResult.calls[0].name, "Read");
			assert.deepEqual(mod.processToolSieveChunk(state, " trailing text"), []);
			const flushed = mod.flushToolSieve(state, [
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			]);
			assert.equal(flushed.text, "trailing text");
			assert.equal(flushed.toolCalls[0].function.name, "Read");
		},
	],
	[
		"uses canonical DSML fast path for plain XML tool blocks",
		async () => {
			const longPath = "x".repeat(16 * 1024);
			const candidate = `<tool_calls><invoke name="Read"><parameter name="path"><![CDATA[${longPath}]]></parameter></invoke></tool_calls>`;
			const fast = mod.parseCanonicalDSMLToolCallsFast(candidate);
			assert.equal(fast.cleanText, "");
			assert.equal(fast.sawToolCallSyntax, true);
			assert.equal(fast.calls[0].name, "Read");
			assert.equal(fast.calls[0].input.path, longPath);

			const [clean, toolCalls] = mod.parseToolCalls(candidate, [
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			]);
			assert.equal(clean, "");
			assert.equal(JSON.parse(toolCalls[0].function.arguments).path, longPath);
		},
	],
	[
		"declines non-canonical DSML fast path inputs",
		async () => {
			assert.equal(
				mod.parseCanonicalDSMLToolCallsFast(
					'```xml\n<tool_calls><invoke name="Read"></invoke></tool_calls>\n```',
				),
				null,
			);
			assert.equal(
				mod.parseCanonicalDSMLToolCallsFast(
					'<tool-calls><invoke name="Read"></invoke></tool-calls>',
				),
				null,
			);
			assert.equal(
				mod.parseCanonicalDSMLToolCallsFast(
					"＜tool_calls＞＜invoke name＝＂Read＂＞＜/invoke＞＜/tool_calls＞",
				),
				null,
			);
			assert.equal(
				mod.parseCanonicalDSMLToolCallsFast(
					'<tool_calls><invoke name="Read"><parameter name="path">`README.md`</parameter></invoke></tool_calls>',
				),
				null,
			);
		},
	],
	[
		"releases oversized unterminated tool candidates as plain text",
		async () => {
			const state = {
				buffer: "unterminated candidate ",
				holdingToolCandidate: true,
				sawToolClose: false,
				parsedToolCandidate: false,
			};
			const oversizedTail = "x".repeat(256 * 1024 + 1);
			const emitted = mod.processToolSieveChunk(state, oversizedTail);
			assert.equal(emitted.join(""), `unterminated candidate ${oversizedTail}`);
			assert.equal(state.buffer, "");
			assert.equal(state.holdingToolCandidate, false);
		},
	],
	[
		"releases oversized partial tool tag candidates as plain text",
		async () => {
			const state = mod.createToolSieveState();
			const prefix = "<tool_calls ";
			assert.deepEqual(mod.processToolSieveChunk(state, prefix), []);

			const oversizedTail = "x".repeat(256 * 1024 + 1);
			const emitted = mod.processToolSieveChunk(state, oversizedTail);
			assert.equal(emitted.join(""), prefix + oversizedTail);
			assert.equal(state.buffer, "");
			assert.equal(state.heldLength, 0);
			assert.equal(state.holdingToolCandidate, false);
		},
	],
	[
		"holds markdown tool-call fences until they are safe to flush",
		async () => {
			const state = mod.createToolSieveState();
			const emitted = mod.processToolSieveChunk(
				state,
				'before\n```tool_call\n{"name":"Read"',
			);
			assert.equal(emitted.join(""), "before\n");
			assert.match(state.buffer, /```tool_call/);
			const flushed = mod.flushToolSieve(state, [
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			]);
			assert.match(flushed.text, /```tool_call/);
			assert.equal(flushed.toolCalls, null);
		},
	],
	[
		"holds unterminated markdown tails without leaking partial code",
		async () => {
			const state = mod.createToolSieveState();
			assert.deepEqual(
				mod.processToolSieveChunk(state, "```js\nconst x = 1;"),
				[],
			);
			assert.match(state.buffer, /```js/);

			const withPrefix = mod.createToolSieveState();
			const emitted = mod.processToolSieveChunk(
				withPrefix,
				"plain before\n```js\nconst x = 1;",
			);
			assert.equal(emitted.join(""), "plain before\n");
			assert.match(withPrefix.buffer, /^```js/);
		},
	],
	[
		"recovers stale tool-sieve holding state to bounded plain text",
		async () => {
			const state = {
				buffer: "x".repeat(100),
				holdingToolCandidate: true,
				sawToolClose: true,
				parsedToolCandidate: false,
			};
			const emitted = mod.processToolSieveChunk(state, "");
			assert.equal(emitted.join(""), "x".repeat(36));
			assert.equal(state.buffer, "x".repeat(64));
			assert.equal(state.holdingToolCandidate, false);
		},
	],
	[
		"releases markdown-protected tool-looking examples from holding state",
		async () => {
			const fenced = "```xml\n<tool_calls></tool_calls>\n```";
			const state = {
				buffer: fenced,
				holdingToolCandidate: true,
				sawToolClose: true,
				parsedToolCandidate: false,
			};
			const emitted = mod.processToolSieveChunk(state, "");
			assert.equal(emitted.join(""), fenced);
			assert.equal(state.buffer, "");
			assert.equal(state.holdingToolCandidate, false);
		},
	],
	[
		"protects markdown tool-looking examples while preserving real tool syntax",
		async () => {
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
			assert.equal(mod.isMarkdownProtectedPosition(text, inlineIndex), true);
			assert.equal(mod.isInsideSimpleMarkdownCodeSpan(text, inlineIndex), true);
			assert.equal(mod.isMarkdownProtectedPosition(text, fencedIndex), true);
			assert.equal(mod.isInsideMarkdownFence(text, fencedIndex), true);
			assert.equal(mod.isMarkdownProtectedPosition(text, realIndex), false);
			assert.equal(mod.findToolCallSyntaxCandidateStart(text), realIndex);

			const masked = mod.maskMarkdownProtectedSpans(text);
			assert.doesNotMatch(masked.text, /before `<tool_calls>/);
			assert.match(masked.text, /GEMINI_MD_PROTECTED_0_TOKEN/);
			assert.equal(masked.restore(masked.text), text);
			assert.equal(mod.markdownProtectedRanges(text).length, 2);
		},
	],
	[
		"detects markdown protected tails and validates fence lines",
		async () => {
			assert.deepEqual(mod.parseMarkdownFenceLine("  ```js"), {
				ch: "`",
				len: 3,
				index: 2,
				canClose: false,
			});
			assert.deepEqual(mod.parseMarkdownFenceLine("~~~"), {
				ch: "~",
				len: 3,
				index: 0,
				canClose: true,
			});
			assert.equal(mod.parseMarkdownFenceLine("```bad`"), null);
			assert.equal(mod.parseMarkdownFenceLine("```<xml>"), null);
			assert.equal(mod.parseMarkdownFenceLine("```bad]"), null);

			const fenceTail = "prefix\n```js\nconst x = 1;";
			assert.equal(mod.openMarkdownFenceStart(fenceTail), "prefix\n".length);
			assert.equal(
				mod.markdownProtectedTailStart(fenceTail),
				"prefix\n".length,
			);

			const codeTail = "prefix `inline";
			assert.equal(mod.openMarkdownCodeSpanStart(codeTail), "prefix ".length);
			assert.equal(mod.markdownProtectedTailStart(codeTail), "prefix ".length);

			const cutText = "hello `code span` after";
			assert.equal(
				mod.markdownProtectedSpanStartAtCut(cutText, cutText.indexOf("span")),
				"hello ".length,
			);
			assert.equal(mod.markdownProtectedSpanStartAtCut(cutText, 0), -1);
			assert.equal(
				mod.markdownProtectedSpanStartAtCut(cutText, cutText.length),
				-1,
			);
		},
	],
	[
		"covers markdown protection CRLF ranges and inline span edges",
		async () => {
			const crlfFence = "intro\r\n```ts\r\nconst x = 1;\r\n```\r\noutro";
			const ranges = mod.markdownProtectedRanges(crlfFence);
			assert.deepEqual(ranges, [
				{
					start: "intro\r\n".length,
					end: "intro\r\n```ts\r\nconst x = 1;\r\n```\r\n".length,
				},
			]);
			assert.equal(
				mod.isMarkdownProtectedPosition(crlfFence, crlfFence.indexOf("const")),
				true,
			);
			assert.equal(
				mod.isMarkdownProtectedPosition(crlfFence, crlfFence.indexOf("outro")),
				false,
			);

			const spans = "a ``two ticks`` and `one tick` done";
			assert.equal(
				mod.isInsideSimpleMarkdownCodeSpan(spans, spans.indexOf("two")),
				true,
			);
			assert.equal(
				mod.isInsideSimpleMarkdownCodeSpan(spans, spans.indexOf("one")),
				true,
			);
			assert.equal(
				mod.isInsideSimpleMarkdownCodeSpan(spans, spans.indexOf("done")),
				false,
			);
			assert.equal(
				mod.markdownProtectedSpanStartAtCut(
					"prefix ``unterminated",
					"prefix ``unterminated".length - 1,
				),
				"prefix ".length,
			);
		},
	],
	[
		"accepts fullwidth confusable DSML tool markup",
		async () => {
			const confusable =
				"＜|DSML|tool_calls＞＜|DSML|invoke name＝＂Read＂＞＜|DSML|parameter name＝＂file_path＂＞README.md＜/|DSML|parameter＞＜/|DSML|invoke＞＜/|DSML|tool_calls＞";
			const [clean, toolCalls] = mod.parseToolCalls(confusable, [
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			]);
			assert.equal(clean, "");
			assert.equal(toolCalls[0].function.name, "Read");
		},
	],
	[
		"keeps legacy fenced markdown tool call JSON as plain text",
		async () => {
			const fenced =
				'before\n```tool_call\n{"name":"Read","arguments":{"file_path":"README.md"}}\n```\nafter';
			const [clean, toolCalls] = mod.parseToolCalls(fenced, [
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			]);
			assert.equal(clean, fenced);
			assert.deepEqual(toolCalls, []);
		},
	],
	[
		"accepts DSML invoke blocks with missing opening root wrapper",
		async () => {
			const text =
				'<|DSML|invoke name="Read"><|DSML|parameter name="file_path">README.md</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>';
			const [clean, toolCalls] = mod.parseToolCalls(text, [
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
		},
	],
	[
		"accepts DSML aliases JSON invoke bodies and nested parameter values",
		async () => {
			const jsonBody =
				'<tool-calls><invoke name="Search">{"arguments":{"query":"docs"}}</invoke></tool-calls>';
			const [, jsonCalls] = mod.parseToolCalls(jsonBody, [
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
			const [, nestedCalls] = mod.parseToolCalls(nested, [
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
		},
	],
	[
		"covers DSML helper fallbacks for fenced examples escaped markup and aliases",
		async () => {
			const fencedExample =
				'keep\n```xml\n<tool_calls><invoke name="Read"></invoke></tool_calls>\n```\nafter';
			assert.equal(mod.stripFencedCodeBlocks(fencedExample), "keep\nafter");
			assert.equal(
				mod.shouldSkipToolCallParsingForCodeFenceExample(fencedExample),
				true,
			);
			const detailed = mod.parseDSMLToolCallsDetailed(
				"<tool_calls><invoke></invoke></tool_calls>",
			);
			assert.equal(detailed.sawToolCallSyntax, true);
			assert.deepEqual(detailed.calls, []);

			assert.deepEqual(
				mod.restoreToolCallProtectedMarkdown(null, () => ""),
				[],
			);
			assert.deepEqual(
				mod.restoreToolCallProtectedMarkdown(
					[{ name: "Read", input: {} }],
					null,
				),
				[],
			);
			assert.equal(
				mod.unwrapToolArgumentMarkdown('```json\n{"ok":true}\n```'),
				'{"ok":true}',
			);
			assert.equal(mod.unwrapToolArgumentMarkdown("plain text"), "plain text");

			const normalized = mod.normalizeDSMLToolCallMarkup(
				'<GeminiToolCalls><GeminiInvoke name="Read"></GeminiInvoke></GeminiToolCalls>',
			);
			assert.equal(
				normalized,
				'<tool_calls><invoke name="Read"></invoke></tool_calls>',
			);
			const [clean, calls] = mod.parseToolCalls(normalized, [
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			]);
			assert.equal(clean, "");
			assert.equal(calls[0].function.name, "Read");

			assert.equal(
				mod.parseMarkupValue(
					"&lt;item&gt;a&lt;/item&gt;&lt;item&gt;2&lt;/item&gt;",
				),
				"<item>a</item><item>2</item>",
			);
			assert.equal(
				mod.parseMarkupValue(
					"&lt;name&gt;Read&lt;/name&gt;&lt;count&gt;2&lt;/count&gt;",
				),
				"<name>Read</name><count>2</count>",
			);
			assert.equal(mod.parseScalarValue("1e999"), "1e999");
			assert.equal(mod.parseScalarValue("{not json}"), "{not json}");
		},
	],
	[
		"keeps legacy tool_call fences as plain text",
		async () => {
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
			const [clean, toolCalls] = mod.parseToolCalls(legacy, [
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
		},
	],
	[
		"builds equivalent prompt text from direct and bundled tools",
		async () => {
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
			const messages = [{ role: "user", content: "find docs" }];
			const directDefs = mod.openAIToolDefs(tools);
			const direct = mod.messagesToPrompt(
				messages,
				tools,
				"auto",
				directDefs,
				"",
				1000000,
			);
			const bundle = mod.createToolBundle(tools);
			const bundled = mod.messagesToPrompt(
				messages,
				bundle,
				"auto",
				bundle.defs,
				"",
				1000000,
			);
			assert.equal(bundled[0], direct[0]);
			assert.equal(bundled.hasToolPrompt, true);
			assert.equal(bundled.hasToolInstructions, true);
			assert.match(mod.toolPromptBlockFor(bundle, ""), /"name": "Search"/);
			assert.doesNotMatch(
				mod.toolPromptBlockFor(bundle, ""),
				/Gemini native hidden tool calls/,
			);
			const transcript = mod.toolsContextTranscriptFor(bundle, "", "tools.txt");
			assert.match(transcript, /Available tool descriptions/);
			assert.match(transcript, /Tool call format instructions/);
			assert.match(transcript, /Gemini native hidden tool calls/);
			assert.match(transcript, /All of the above is system prompt content/);
		},
	],
	[
		"builds filters and caches tool bundles without losing schemas",
		async () => {
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
			const bundle = mod.createToolBundle(source);
			assert.equal(mod.createToolBundle(bundle), bundle);
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

			const filtered = mod.filterToolBundleByPolicy(bundle, {
				mode: "forced",
				allowed: { Read: true },
				hasAllowed: true,
			});
			assert.deepEqual(filtered.names, ["Read"]);
			assert.equal(filtered.schemaIndex.read.properties.path.type, "string");
			assert.equal(mod.nullableOpenAIFunctionTools(filtered).length, 1);
			assert.equal(
				mod.nullableOpenAIFunctionTools(
					mod.filterToolBundleByPolicy(bundle, { mode: "none" }),
				),
				null,
			);
			assert.equal(
				mod.nullableOpenAIFunctionTools(
					mod.filterToolBundleByPolicy(bundle, {
						allowed: { Missing: true },
						hasAllowed: true,
					}),
				),
				null,
			);
			assert.equal(mod.filterToolBundleByPolicy(bundle, null), bundle);

			assert.deepEqual(
				mod.toolNamesForPromptSource([
					{ name: "Search" },
					{ name: "Search" },
					{ name: "" },
				]),
				["Search"],
			);
			assert.match(
				mod.toolCallInstructionsFor([{ name: "Search" }]),
				/<\|DSML\|tool_calls>/,
			);
			const empty = mod.createToolBundle([{ type: "function", function: {} }]);
			assert.deepEqual(empty.names, []);
			assert.equal(empty.items.length, 1);
		},
	],
	[
		"builds prompt examples only for known tool shapes",
		async () => {
			assert.equal(mod.hasReadLikeTool([" read-file ", "Search"]), true);
			assert.equal(mod.hasReadLikeTool("Read"), false);
			assert.equal(
				mod
					.buildReadToolCacheGuard(["read_file"])
					.includes("Read-tool cache guard"),
				true,
			);
			assert.equal(mod.buildReadToolCacheGuard(["Search"]), "");
			assert.deepEqual(
				mod.uniqueToolNames([" Read ", "Read", "", null, "Glob"]),
				["Read", "Glob"],
			);

			const names = [
				"Unknown",
				"Read",
				"Glob",
				"Task",
				"Bash",
				"write_to_file",
			];
			assert.deepEqual(mod.firstBasicExample(names), {
				name: "Read",
				params: mod.exampleBasicParams("Read"),
			});
			assert.deepEqual(
				mod.firstNBasicExamples(names, 2).map((example) => example.name),
				["Read", "Glob"],
			);
			assert.equal(mod.firstNestedExample(names).name, "Task");
			assert.equal(mod.firstScriptExample(names).name, "Bash");
			assert.equal(mod.exampleBasicParams("Unknown"), null);
			assert.equal(mod.exampleNestedParams("Unknown"), null);
			assert.equal(mod.exampleScriptParams("Unknown"), null);

			const block = mod.renderToolExampleBlock([
				{ name: 'Run"Now', params: mod.exampleScriptParams("execute_command") },
			]);
			assert.match(block, /<\|DSML\|invoke name="Run&quot;Now">/);
			assert.match(block, /<!\[CDATA\[cat > \/tmp\/test_escape\.sh/);
			assert.match(block, /<\/\|DSML\|tool_calls>$/);

			const examples = mod.buildCorrectToolExamples(names);
			assert.match(examples, /Example A - Single tool/);
			assert.match(examples, /Example B - Two tools in parallel/);
			assert.match(examples, /Example C - Tool with nested XML parameters/);
			assert.match(examples, /Example D - Tool with long script using CDATA/);
			assert.equal(mod.buildCorrectToolExamples(["Unknown"]), "");
		},
	],
	[
		"normalizes tool metadata across OpenAI Google and Responses aliases",
		async () => {
			const schema = {
				type: "object",
				properties: { query: { type: "string" } },
			};
			assert.equal(mod.extractToolMeta(null), null);
			assert.deepEqual(
				mod.extractToolMeta({
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
				mod.extractToolMeta({
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
				mod.toolFunctionDeclarations(grouped).map((item) => item.name),
				["GoogleSearch", ""],
			);
			assert.deepEqual(
				mod.toolFunctionDeclarations({ functionDeclarations: {} }),
				[],
			);
			assert.deepEqual(
				mod
					.toolItemsFromTools({ tools: [{ name: "List", schema }, "skip"] })
					.map((item) => item.name),
				["List"],
			);
			assert.equal(mod.toolItemsFromTools({ nope: true }).length, 0);
			assert.deepEqual(mod.toolMetasFromTools(grouped), [
				{
					name: "GoogleSearch",
					description: "Google style",
					parameters: schema,
				},
			]);
			assert.deepEqual(mod.toolDefsFromTools([{ name: "NoSchema" }]), [
				{
					name: "NoSchema",
					description: "",
					parameters: {},
				},
			]);
			assert.deepEqual(mod.normalizeToolsToOpenAIFunctionTools(grouped), [
				{
					type: "function",
					function: {
						name: "GoogleSearch",
						description: "Google style",
						parameters: schema,
					},
				},
			]);
			assert.equal(
				mod.normalizeToolsToOpenAIFunctionTools([{ name: "" }]),
				null,
			);
			assert.equal(mod.firstNonNil(null, undefined, false, "fallback"), false);
		},
	],
	[
		"finalizes OpenAI text into tool calls",
		async () => {
			const finalized = mod.finalizeOpenAICompletionResult(
				'<tool_calls><invoke name="Read"><parameter name="file_path">README.md</parameter></invoke></tool_calls>',
				{
					tools: [
						{
							type: "function",
							function: { name: "Read", parameters: { type: "object" } },
						},
					],
					promptToolChoice: "auto",
					structured: null,
					toolPolicy: null,
				},
			);
			assert.equal(finalized.error, undefined);
			assert.equal(finalized.toolCalls[0].function.name, "Read");
		},
	],
	[
		"validates structured output schema combinators and scalar constraints",
		async () => {
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
				mod.validateStructuredOutputValue(
					{ kind: "alpha", tag: "ok-ready", items: [1, 2], score: 1.5 },
					requirement,
				),
				"",
			);
			assert.match(
				mod.validateStructuredOutputValue(
					{ kind: "gamma", tag: "ok-ready", items: [1, 2], score: 1.5 },
					requirement,
				),
				/oneOf/,
			);
			assert.match(
				mod.validateStructuredOutputValue(
					{ kind: "alpha", tag: "bad", items: [1, 2], score: 1.5 },
					requirement,
				),
				/anyOf/,
			);
			assert.match(
				mod.validateStructuredOutputValue(
					{ kind: "alpha", tag: 12, items: [1, 1], score: 1.5 },
					requirement,
				),
				/unique/,
			);
			assert.match(
				mod.validateStructuredOutputValue(
					{ kind: "alpha", tag: 12, items: [1, 2], score: 1.3 },
					requirement,
				),
				/multiple/,
			);
			assert.match(
				mod.validateStructuredOutputValue(
					{ kind: "alpha", tag: 12, items: [1, 2], score: 1.5, extra: true },
					requirement,
				),
				/not allowed/,
			);
		},
	],
	[
		"validates structured output object array and type edge cases",
		async () => {
			assert.equal(
				mod.validateStructuredOutputValue("nope", { type: "json_object" }),
				"structured output must be a JSON object",
			);
			assert.equal(
				mod.validateStructuredOutputValue(
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
				mod.validateStructuredOutputValue(
					{ a: "x" },
					{
						type: "json_schema",
						schema: { type: "object", minProperties: 2 },
					},
				),
				/at least 2 properties/,
			);
			assert.match(
				mod.validateStructuredOutputValue(
					{ a: "x", b: 2, c: 3 },
					{
						type: "json_schema",
						schema: { type: "object", maxProperties: 2 },
					},
				),
				/at most 2 properties/,
			);
			assert.match(
				mod.validateStructuredOutputValue(
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
				mod.validateStructuredOutputValue([1, "two", true], {
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
				mod.validateStructuredOutputValue(2, {
					type: "json_schema",
					schema: { type: ["string", "integer"] },
				}),
				"",
			);
			assert.equal(
				mod.validateStructuredOutputValue(
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
				mod.validateStructuredOutputValue(
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
				mod.validateStructuredOutputValue("abcd", {
					type: "json_schema",
					schema: { type: "string", minLength: 2, maxLength: 3 },
				}),
				/at most 3/,
			);
			assert.equal(
				mod.validateStructuredOutputValue("anything", {
					type: "json_schema",
					schema: { type: "string", pattern: "[" },
				}),
				"",
			);
			assert.match(
				mod.validateStructuredOutputValue(1, {
					type: "json_schema",
					schema: { oneOf: [{ type: "number" }, { type: "integer" }] },
				}),
				/matched 2/,
			);
		},
	],
	[
		"builds and finalizes structured output requirements from noisy JSON text",
		async () => {
			assert.equal(
				mod.getStructuredResponseFormat({
					text: { format: { type: "json_object" } },
				}).type,
				"json_object",
			);
			assert.equal(mod.getStructuredResponseFormat(null), null);
			assert.equal(
				mod.buildStructuredOutputRequirement({
					type: "json_schema",
					json_schema: { name: "bad" },
				}).error,
				"response_format json_schema requires a schema object",
			);
			const cyclic = {};
			cyclic.self = cyclic;
			assert.equal(
				mod.buildStructuredOutputRequirement({
					type: "json_schema",
					json_schema: { schema: cyclic },
				}).error,
				"response_format json_schema schema must be JSON serializable",
			);
			const requirement = mod.buildStructuredOutputRequirement({
				type: "json_schema",
				name: "loose_result",
				strict: false,
				schema: { type: "object", properties: { ok: { type: "boolean" } } },
			});
			assert.match(requirement.instruction, /Schema name: loose_result/);
			assert.match(requirement.instruction, /Strict mode: false/);
			assert.equal(
				mod.extractFirstJsonDocument('prefix [1,{"a":"}"}] suffix'),
				'[1,{"a":"}"}]',
			);
			assert.equal(
				mod.extractFirstJsonDocument('prefix [{"ok":true} } suffix'),
				'{"ok":true}',
			);
			assert.equal(mod.extractFirstJsonDocument('prefix {"a":] suffix'), "");
			assert.equal(mod.extractFirstJsonDocument("{{{{"), "");
			assert.deepEqual(
				mod.parseStructuredJsonCandidate('prefix {"ok":true} suffix'),
				{ ok: true },
			);
			assert.equal(
				mod.parseStructuredJsonCandidate("no json here"),
				mod.STRUCTURED_JSON_NOT_FOUND,
			);
			assert.equal(
				mod.canonicalizeStructuredOutputText(
					'prefix {"ok":true} suffix',
					requirement,
				),
				'{"ok":true}',
			);
			assert.match(
				mod.finalizeStructuredOutputText('prefix {"ok":true} suffix', {
					type: "json_schema",
					schema: { allOf: [{ type: "object" }, { required: ["missing"] }] },
				}).error,
				/\.missing is required/,
			);
			assert.equal(
				mod.finalizeStructuredOutputText("not json", requirement).error,
				"structured output was not valid JSON",
			);
		},
	],
	[
		"compares nested JSON values independent of object key order",
		async () => {
			assert.equal(
				mod.jsonValuesEqual(
					{ a: [1, { b: true }], c: null },
					{ c: null, a: [1, { b: true }] },
				),
				true,
			);
			assert.equal(
				mod.jsonValuesEqual({ a: [1, { b: true }] }, { a: [1, { b: false }] }),
				false,
			);
			assert.equal(mod.jsonValuesEqual([1, 2], [2, 1]), false);
		},
	],
	[
		"rejects tool calls when OpenAI tool choice is none",
		async () => {
			const finalized = mod.finalizeOpenAICompletionResult(
				'<tool_calls><invoke name="Read"><parameter name="file_path">README.md</parameter></invoke></tool_calls>',
				{
					tools: null,
					noneModeTools: [
						{
							type: "function",
							function: { name: "Read", parameters: { type: "object" } },
						},
					],
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
		},
	],
	[
		"streams OpenAI tool choice violation and DONE marker",
		async () => {
			const writes = [];
			await mod.streamOpenAIChatWithToolSieve(
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
					tools: [
						{
							type: "function",
							function: { name: "Read", parameters: { type: "object" } },
						},
					],
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
		},
	],
	[
		"streams Responses failure for missing required tool call",
		async () => {
			const writes = [];
			await mod.streamResponsesWithToolSieve(
				(chunk) => writes.push(chunk),
				{},
				{
					provider: fakeStreamProvider(["plain answer"]),
					rid: "resp_test",
					rm: { name: "gemini-3.5-flash" },
					prompt: "must call a tool",
					fileRefs: null,
					tools: [
						{
							type: "function",
							function: { name: "Read", parameters: { type: "object" } },
						},
					],
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
		},
	],
	[
		"moves large tool context into attached tools file",
		async () => {
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
			const result = await mod.prepareContextFilesWithUploader(
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
			assert.match(
				uploads[1].text,
				/All of the above is system prompt content/,
			);
			assert.match(result.promptTokenText, /user history/);
			assert.match(result.promptTokenText, /Available tool descriptions/);
			assert.match(result.promptTokenText, /Gemini native hidden tool calls/);
		},
	],
	[
		"keeps hidden native tool prompt separate from DSML instructions",
		async () => {
			const cfg = {
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "",
				log_requests: false,
			};
			const result = await mod.prepareOpenAIGeminiContext(
				cfg,
				fakeStreamProvider([]),
				{},
				[{ role: "user", content: "what changed today?" }],
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
		},
	],
	[
		"normalizes Responses-style tools and nested XML arguments",
		async () => {
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
			const result = await mod.prepareOpenAIGeminiContext(
				cfg,
				fakeStreamProvider([]),
				{},
				[{ role: "user", content: "find docs" }],
				tools,
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

			const finalized = mod.finalizeOpenAICompletionResult(
				'<tool_calls><invoke name="Search"><parameter name="query"><term>docs</term></parameter></invoke></tool_calls>',
				{
					tools,
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
		},
	],
	[
		"accepts OpenAI tool schema aliases",
		async () => {
			for (const key of ["input_schema", "inputSchema", "schema"]) {
				const schema = {
					type: "object",
					properties: { value: { type: "string" } },
				};
				const defs = mod.openAIToolDefs([
					{ type: "function", name: `Alias_${key}`, [key]: schema },
				]);
				assert.equal(defs[0].name, `Alias_${key}`);
				assert.deepEqual(defs[0].parameters, schema);
			}
		},
	],
	[
		"formats prompt tool-call parameters with XML-safe fallbacks",
		async () => {
			const block = mod.formatPromptToolCallBlock('Run"Now', {
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
			assert.equal(mod.isSafeXmlElementName("a.b-c_1"), true);
			assert.equal(mod.isSafeXmlElementName("1bad"), false);
			assert.equal(mod.formatPromptParamValue(Symbol("skip")), "");
		},
	],
	[
		"formats OpenAI tool call payloads and prompt XML helper edges",
		async () => {
			assert.deepEqual(mod.formatOpenAIToolCalls(null, []), []);
			assert.deepEqual(mod.formatOpenAIStreamToolCalls([], new Map(), []), []);

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
			const calls = [
				{ name: "Lookup", input: { query: { term: "docs" }, count: "3" } },
				{ name: "NoInput" },
			];
			const formatted = mod.formatOpenAIToolCalls(calls, tools);
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
			const streamCalls = mod.formatOpenAIStreamToolCalls(calls, ids, tools);
			assert.equal(streamCalls[0].index, 0);
			assert.match(streamCalls[0].id, /^call_[0-9a-f]{32}$/);
			assert.equal(mod.ensureStreamToolCallID(ids, 0), streamCalls[0].id);
			const fallbackId = mod.ensureStreamToolCallID(null, 0);
			assert.match(fallbackId, /^call_[0-9a-f]{32}$/);
			const nonIntegerId = mod.ensureStreamToolCallID(ids, "not-an-index");
			assert.equal(nonIntegerId, streamCalls[0].id);

			assert.equal(mod.promptCDATA(""), "");
			assert.equal(mod.promptCDATA("a]]>b"), "<![CDATA[a]]]]><![CDATA[>b]]>");
			assert.equal(mod.xmlEscapeAttr(null), "");
			assert.equal(mod.xmlEscapeAttr('a&"<>'), "a&amp;&quot;&lt;&gt;");
			assert.equal(
				mod.indentPromptParameters("", "  "),
				'  <|DSML|parameter name="content"></|DSML|parameter>',
			);
			assert.equal(
				mod.indentPromptParameters("one\n\n two", "  "),
				"  one\n\n   two",
			);
			assert.equal(
				mod.wrapParameter('bad"&<>', "value"),
				'<|DSML|parameter name="bad&quot;&amp;&lt;&gt;">value</|DSML|parameter>',
			);
		},
	],
	[
		"parses XML helper edges for nested tags CDATA and malformed markup",
		async () => {
			assert.equal(mod.decodeCDATA("<![CDATA[open"), "open");
			assert.equal(mod.decodeCDATA("<![CDATA[a]]><![CDATA[>b]]>"), "a>b");
			assert.equal(
				mod.decodeXmlEntities("&lt;a x=&quot;1&quot; y=&apos;2&apos;&gt;&amp;"),
				"<a x=\"1\" y='2'>&",
			);

			const values = { a: 1 };
			mod.appendMarkupValue(values, "a", 2);
			mod.appendMarkupValue(values, "a", 3);
			mod.appendMarkupValue(values, "b", "one");
			assert.deepEqual(values, { a: [1, 2, 3], b: "one" });

			assert.deepEqual(
				mod.parseTagAttributes(
					'a="1&amp;2" b=\'two\' c=bare d="x>y" a=ignored',
				),
				{
					a: "1&2",
					b: "two",
					c: "bare",
					d: "x>y",
				},
			);

			const nested =
				'ignore <![CDATA[<item>skip</item>]]><item id="1"><item/>body</item><item>two</item><item>broken';
			const blocks = mod.findXmlElementBlocks(nested, "item");
			assert.equal(blocks.length, 2);
			assert.equal(blocks[0].attrs.trim(), 'id="1"');
			assert.equal(blocks[0].body, "<item/>body");
			assert.equal(blocks[1].body, "two");
			assert.deepEqual(
				mod.findXmlElementBlocks("<item>unterminated", "item"),
				[],
			);

			const top = mod.findTopLevelXmlElementBlocks(
				"<root><child>1</child></root><solo/>",
			);
			assert.deepEqual(
				top.map((block) => block.name),
				["root", "solo"],
			);
			assert.equal(top[1].body, "");
			assert.deepEqual(
				mod.findTopLevelXmlElementBlocks("leading <root></root>"),
				[],
			);
			assert.deepEqual(
				mod.findTopLevelXmlElementBlocks("<root><child></root> trailing"),
				[],
			);

			assert.equal(mod.findNextXmlTag("<a></a>", "a", 0, false).closing, false);
			assert.equal(mod.findNextXmlTag("<a></a>", "a", 0, true).closing, true);
			assert.equal(mod.findNextXmlTag("<a></a>", "b", 0, null), null);
			assert.equal(
				mod.findNextAnyXmlTag("x <![CDATA[<a>]]> <b/>", 0, false).name,
				"b",
			);
			assert.equal(mod.skipCDATAAt("<![CDATA[x]]><a>", 0), 13);
			assert.equal(mod.skipCDATAAt("plain", 0), 0);

			assert.equal(mod.scanXmlTagAt("x<a>", 0), null);
			assert.equal(mod.scanXmlTagAt("<1bad>", 0), null);
			assert.equal(
				mod.scanXmlTagAt('<bad:name attr="x>y">', 0).attrs.trim(),
				'attr="x>y"',
			);
			assert.equal(mod.scanXmlTagAt('<bad:name attr="unterminated>', 0), null);
			assert.equal(mod.findXmlTagEnd('<a x="y>z"', 3), -1);
		},
	],
	[
		"normalizes parsed tool-call arguments through schema aliases",
		async () => {
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
			const normalized = mod.normalizeParsedToolCallsForSchemas(calls, tools);
			assert.equal(normalized[0].input.query, '{"term":"docs"}');
			assert.equal(normalized[0].input.maybe, "5");
			assert.deepEqual(normalized[0].input.choices, ["7", { a: "1" }, false]);
			assert.equal(normalized[0].input.extra, "true");
			assert.equal(normalized[1], "not a call");
			assert.deepEqual(normalized[2], calls[2]);
			assert.deepEqual(normalized[3], calls[3]);
			assert.deepEqual(
				mod.buildToolSchemaIndex(tools).lookup,
				tools[0].function.parameters,
			);
		},
	],
	[
		"keeps schema normalization conservative when no conversion is required",
		async () => {
			assert.deepEqual(mod.normalizeParsedToolCallsForSchemas(null, []), null);
			assert.deepEqual(mod.normalizeParsedToolCallsForSchemas([], []), []);
			assert.deepEqual(
				mod.normalizeToolValueWithSchema(null, { type: "string" }),
				[null, false],
			);
			assert.deepEqual(mod.normalizeToolValueWithSchema({ a: 1 }, null), [
				{ a: 1 },
				false,
			]);
			assert.deepEqual(
				mod.normalizeToolValueWithSchema([], {
					type: "array",
					items: { type: "string" },
				}),
				[[], false],
			);
			assert.deepEqual(
				mod.normalizeToolValueWithSchema(["x"], {
					type: "array",
					items: [null],
				}),
				[["x"], false],
			);
			assert.equal(mod.shouldCoerceSchemaToString({ const: "fixed" }), true);
			assert.equal(mod.shouldCoerceSchemaToString({ enum: ["a", "b"] }), true);
			assert.equal(
				mod.shouldCoerceSchemaToString({ type: ["string", "null"] }),
				true,
			);
			assert.equal(
				mod.shouldCoerceSchemaToString({ type: ["string", "integer"] }),
				false,
			);
			assert.equal(mod.looksLikeObjectSchema({ properties: {} }), true);
			assert.equal(mod.looksLikeArraySchema({ items: {} }), true);
			const cyclic = {};
			cyclic.self = cyclic;
			assert.deepEqual(mod.stringifySchemaValue(cyclic), [cyclic, false]);
		},
	],
	[
		"accepts wrapped OpenAI tool definitions in tool choice policy",
		async () => {
			const schema = {
				type: "object",
				properties: { query: { type: "string" } },
			};
			const defs = mod.openAIToolDefs([
				{
					type: "function",
					tool: {
						name: "WrappedSearch",
						description: "Search docs",
						input_schema: schema,
					},
				},
			]);
			assert.equal(defs[0].name, "WrappedSearch");
			assert.equal(defs[0].description, "Search docs");
			assert.deepEqual(defs[0].parameters, schema);
			const policy = mod.parseOpenAIToolChoicePolicy(
				{ type: "function", name: "WrappedSearch" },
				[
					{
						type: "function",
						tool: { name: "WrappedSearch", input_schema: schema },
					},
				],
			);
			assert.equal(policy.error, "");
			assert.equal(policy.forcedName, "WrappedSearch");
		},
	],
	[
		"parses OpenAI allowed_tools policy aliases and filters duplicates",
		async () => {
			const tools = [
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
				{
					type: "function",
					function: { name: "Search", parameters: { type: "object" } },
				},
			];
			const policy = mod.parseOpenAIToolChoicePolicy(
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
		},
	],
	[
		"reports OpenAI tool choice shape errors without changing policy mode",
		async () => {
			const tools = [
				{
					type: "function",
					function: { name: "Read", parameters: { type: "object" } },
				},
			];
			assert.match(
				mod.parseOpenAIToolChoicePolicy(42, tools).error,
				/must be a string or object/,
			);
			assert.match(
				mod.parseOpenAIToolChoicePolicy("sometimes", tools).error,
				/unsupported tool_choice/,
			);
			assert.match(
				mod.parseOpenAIToolChoicePolicy(
					{ type: "allowed_tools", mode: "always", tools: ["Read"] },
					tools,
				).error,
				/unsupported tool_choice\.mode/,
			);
			assert.match(
				mod.parseOpenAIToolChoicePolicy(
					{ type: "allowed_tools", tools: [{}] },
					tools,
				).error,
				/did not contain any valid tool names/,
			);
			assert.match(
				mod.parseOpenAIToolChoicePolicy(
					{ type: "function", function: { name: "Missing" } },
					tools,
				).error,
				/forced tool is not declared/,
			);
			assert.match(
				mod.parseOpenAIToolChoicePolicy({ type: "function" }, tools).error,
				/requires function\.name/,
			);
		},
	],
	[
		"covers OpenAI tool choice policy helper edge cases",
		async () => {
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
			const googleGroup = {
				functionDeclarations: [{ name: "Lookup" }, { name: "Read" }],
			};
			assert.deepEqual(mod.extractToolNames(tools), ["Read", "Search"]);
			assert.deepEqual(mod.extractToolNames(googleGroup), ["Lookup", "Read"]);
			assert.deepEqual(mod.extractToolNames(mod.createToolBundle(tools)), [
				"Read",
				"Search",
			]);
			assert.deepEqual(mod.namesToSet(["Read", "", null, "Search"]), {
				Read: true,
				Search: true,
			});
			assert.equal(mod.allowedToolNameFromItem(" Read "), " Read ");
			assert.equal(
				mod.allowedToolNameFromItem({ function: { name: "Search" } }),
				"Search",
			);
			assert.equal(
				mod.allowedToolNameFromItem({ tool: { name: "Lookup" } }),
				"Lookup",
			);
			assert.equal(mod.allowedToolNameFromItem(5), "");

			assert.equal(mod.parseAllowedToolNames(null), null);
			assert.deepEqual(mod.parseAllowedToolNames("Read, Search"), {
				names: ["Read", "Search"],
			});
			assert.deepEqual(
				mod.parseAllowedToolNames({
					allowed_tools: [
						{ function: { name: "Read" } },
						{ tool: { name: "Search" } },
						"Read",
					],
				}),
				{ names: ["Read", "Search"] },
			);
			assert.match(mod.parseAllowedToolNames([]).error, /non-empty array/);
			assert.match(
				mod.parseAllowedToolNames([{}]).error,
				/did not contain any valid tool names/,
			);
			assert.equal(mod.parseForcedToolName({ name: "Read" }), "Read");
			assert.equal(
				mod.parseForcedToolName({ function: { name: "Search" } }),
				"Search",
			);
			assert.equal(mod.parseForcedToolName("Read"), "");

			const forcedAuto = mod.parseOpenAIToolChoicePolicy(
				{ type: "auto", name: "Read" },
				tools,
			);
			assert.equal(forcedAuto.mode, "forced");
			assert.deepEqual(forcedAuto.allowed, { Read: true });
			const noneObject = mod.parseOpenAIToolChoicePolicy(
				{ type: "none" },
				tools,
			);
			assert.equal(noneObject.mode, "none");
			assert.deepEqual(noneObject.allowed, {});
			assert.match(
				mod.parseOpenAIToolChoicePolicy({ type: "required" }, []).error,
				/requires at least one tool/,
			);
			assert.match(
				mod.parseOpenAIToolChoicePolicy({ allowed_tools: ["Missing"] }, tools)
					.error,
				/allowed unknown tool/,
			);

			assert.equal(mod.policyHasAllowed(null), false);
			assert.equal(
				mod.policyHasAllowed({ allowed: {}, hasAllowed: false }),
				false,
			);
			assert.equal(
				mod.policyHasAllowed({ allowed: { Read: true }, hasAllowed: false }),
				true,
			);
			assert.equal(mod.toolPolicyAllows(null, "Anything"), true);
			assert.equal(mod.toolPolicyAllows(noneObject, "Read"), false);
			assert.equal(mod.toolPolicyAllows(forcedAuto, "Read"), true);
			assert.equal(mod.toolPolicyAllows(forcedAuto, "Search"), false);

			assert.equal(mod.filterToolsByPolicy(null, forcedAuto), null);
			assert.equal(mod.filterToolsByPolicy(tools, { mode: "none" }), null);
			assert.equal(mod.filterToolsByPolicy(tools, null), tools);
			assert.deepEqual(
				mod
					.filterToolsByPolicy(tools, forcedAuto)
					.map((tool) => tool.function.name),
				["Read", "Read"],
			);
			assert.deepEqual(
				mod
					.filterToolsByPolicy(mod.createToolBundle(tools), forcedAuto)
					.map((tool) => tool.function.name),
				["Read", "Read"],
			);

			assert.equal(mod.buildToolChoiceInstructionFromPolicy(null), "");
			assert.equal(
				mod.buildToolChoiceInstructionFromPolicy({ mode: "auto" }),
				"",
			);
			assert.match(
				mod.buildToolChoiceInstructionFromPolicy(noneObject),
				/Do NOT call any tools/,
			);
			assert.match(
				mod.buildToolChoiceInstructionFromPolicy(forcedAuto),
				/MUST call the tool "Read"/,
			);
			assert.match(
				mod.buildToolChoiceInstructionFromPolicy({
					mode: "required",
					allowed: { Read: true, Search: true },
				}),
				/"Read", "Search"/,
			);
			assert.match(
				mod.buildToolChoiceInstructionFromPolicy({
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
			assert.equal(mod.validateRequiredToolCalls(null, []), null);
			assert.match(
				mod.validateRequiredToolCalls(required, []).message,
				/requires at least one valid tool call/,
			);
			assert.match(
				mod.validateRequiredToolCalls(required, [
					{ function: { name: "Search" } },
					{ name: "Search" },
				]).message,
				/Search/,
			);
			const forcedMissing = mod.validateRequiredToolCalls(forcedAuto, [
				{ function: { name: "" } },
			]);
			assert.match(forcedMissing.message, /requires the tool Read/);
			assert.equal(
				mod.validateRequiredToolCalls(forcedAuto, [{ name: "Read" }]),
				null,
			);
			assert.deepEqual(
				mod.validateToolPolicyCalls(forcedAuto, [], {
					requiredMessage: "need call",
					badMessage: (names) => `bad ${names}`,
					forcedMessage: (name) => `missing ${name}`,
				}),
				{ message: "need call", code: "tool_choice_violation" },
			);
		},
	],
	[
		"uses fallback tool defs when prompt source has no tools",
		async () => {
			const result = mod.messagesToPrompt(
				[{ role: "user", content: "find docs" }],
				null,
				"auto",
				[
					{
						name: "Search",
						description: "Search docs",
						parameters: {
							type: "object",
							properties: { query: { type: "string" } },
						},
					},
				],
				"",
				1000000,
			);
			assert.match(result[0], /Available tools/);
			assert.match(result[0], /"name": "Search"/);
			assert.match(result[0], /"query"/);
			assert.doesNotMatch(result[0], /Gemini native hidden tool calls/);
		},
	],
];
