import { describe, test } from "vitest";
import {
	appendMarkupValue,
	decodeCDATA,
	decodeXmlEntities,
	findTopLevelXmlElementBlocks,
	findXmlElementBlocks,
	parseTagAttributes,
} from "../../../src/toolcall/xml";
import { assert } from "../assertions.js";
import { required } from "./_support/assertions.js";

describe("toolcall", () => {
	test("parses CDATA entities nested tags and top-level blocks", async () => {
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
		assert.equal(required(blocks[0]).attrs.trim(), 'id="1"');
		assert.equal(required(blocks[0]).body, "<item/>body");
		assert.equal(required(blocks[1]).body, "two");
		assert.deepEqual(findXmlElementBlocks("<item>unterminated", "item"), []);

		const top = findTopLevelXmlElementBlocks(
			"<root><child>1</child></root><solo/>",
		);
		assert.deepEqual(
			top.map((block) => block.name),
			["root", "solo"],
		);
		assert.equal(required(top[1]).body, "");
		assert.deepEqual(findTopLevelXmlElementBlocks("leading <root></root>"), []);
		assert.deepEqual(
			findTopLevelXmlElementBlocks("<root><child></root> trailing"),
			[],
		);
	});
});
