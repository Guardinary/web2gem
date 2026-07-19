import { describe, test } from "vitest";
import {
	buildHeaders,
	buildPayload,
	getUrl,
} from "../../../../src/gemini/client/protocol";
import { assert } from "../../assertions.js";
import { baseGeminiClientConfig } from "../_support/client-fixtures.js";

describe("Gemini client protocol", () => {
	test("builds Gemini payload with model number and extended thinking", () => {
		const payload = buildPayload(
			"prompt",
			3,
			true,
			[{ ref: "file-ref", name: "doc.txt" }],
			"req-test",
		);
		const encodedRequest = new URLSearchParams(payload).get("f.req");
		if (encodedRequest === null) throw new Error("missing f.req payload");
		const outer = JSON.parse(encodedRequest);
		const inner = JSON.parse(outer[1]);
		assert.equal(inner.length, 102);
		assert.equal(inner[0][0], "prompt");
		assert.equal(inner[0][3][0][0][0], "file-ref");
		assert.equal(inner[0][3][0][1], "doc.txt");
		assert.equal(inner[3], null);
		assert.deepEqual(inner[17], [[0]]);
		assert.equal(inner[31], null);
		assert.equal(inner[59], "REQ-TEST");
		assert.equal(inner[79], 3);
		assert.equal(inner[80], 2);
		assert.throws(
			() => buildPayload("prompt", 123, false, null),
			/invalid Gemini model number/,
		);
		assert.throws(
			() => Reflect.apply(buildPayload, undefined, ["prompt", 1, 2, null]),
			/invalid Gemini extended-thinking flag/,
		);
	});
	test("builds Gemini request URL and browser headers", async () => {
		const cfg = baseGeminiClientConfig({
			gemini_origin: "https://gemini.example/",
			gemini_bl: "boq test",
			cookie: "SID=ok",
		});
		const url = getUrl(cfg);
		assert.match(
			url,
			/^https:\/\/gemini\.example\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate\?/,
		);
		assert.match(url, /bl=boq%20test/);

		const headers = await buildHeaders(
			cfg,
			{
				"x-goog-ext-525001261-jspb":
					'[1,null,null,null,"model-id",null,null,0,[4],null,null,1]',
			},
			"request-id",
		);
		assert.equal(headers.Cookie, "SID=ok");
		assert.equal(headers.Origin, "https://gemini.google.com");
		assert.equal(headers["X-Same-Domain"], "1");
		assert.equal(
			headers["x-goog-ext-525001261-jspb"],
			'[1,null,null,null,"model-id",null,null,0,[4],null,null,1]',
		);
		assert.equal(headers["x-goog-ext-525005358-jspb"], '["REQUEST-ID",1]');
		assert.equal(headers.Authorization, undefined);
	});
});
