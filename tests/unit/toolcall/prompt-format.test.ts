import { describe, test } from "vitest";
import { formatPromptToolCallBlock } from "../../../src/toolcall/prompt-format";
import {
	indentPromptParameters,
	promptCDATA,
	wrapParameter,
	xmlEscapeAttr,
} from "../../../src/toolcall/prompt-xml";
import { assert } from "../assertions.js";

describe("toolcall", () => {
	test("formats prompt tool-call parameters with XML-safe fallbacks", async () => {
		const block = formatPromptToolCallBlock('Run"Now', {
			text: "a]]>b",
			shape: {
				valid_name: true,
				"bad key": ["x", null, 2, false, undefined],
			},
			empty: undefined,
			skip: Symbol("skip"),
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
		assert.match(block, /<\|DSML\|parameter name="skip"><\/\|DSML\|parameter>/);
		// Nested object keys: safe names render as tags; unsafe names use <field>.
		assert.match(
			formatPromptToolCallBlock("x", { nested: { "1bad": "nope" } }),
			/<field name="1bad"><!\[CDATA\[nope\]\]><\/field>/,
		);
		assert.match(
			formatPromptToolCallBlock("x", { nested: { "a.b-c_1": true } }),
			/<a\.b-c_1>true<\/a\.b-c_1>/,
		);
	});
	test("formats prompt XML CDATA attributes and indentation", async () => {
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
});
