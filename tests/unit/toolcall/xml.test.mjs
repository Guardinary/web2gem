import { describe, test } from "vitest";
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
} from "../../../src/toolcall/xml";
import { assert } from "../assertions.js";

describe("toolcall", () => {
	test("parses CDATA entities nested tags and malformed XML boundaries", async () => {
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
});
