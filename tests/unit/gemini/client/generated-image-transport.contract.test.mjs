import { afterEach, beforeEach, describe, test } from "vitest";
import { base64ToBytes } from "../../../../src/attachments/base64";
import { generateRich } from "../../../../src/gemini/client";
import { resetGeminiBuildLabelCacheForTest } from "../../../../src/gemini/client/retry";
import { _setConnectForTest } from "../../../../src/gemini/transport/socket";
import { assert } from "../../assertions.js";
import { fakeSocketConnect, withFetch } from "../../helpers.js";
import { baseGeminiClientConfig } from "../_support/client-fixtures.js";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function richWrbLine(candidate) {
	const inner = [null, null, null, null, [candidate], "x".repeat(160)];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

function generatedImageEntry(
	url = "https://lh3.googleusercontent.com/generated=s1024-rj",
	id = "img_1",
) {
	const meta = [];
	meta[3] = [];
	meta[3][2] = "generated alt";
	meta[3][3] = url;
	return [meta, [id]];
}

function generatedImageCandidate(
	text = "final text",
	url = "https://lh3.googleusercontent.com/generated=s1024-rj",
) {
	const candidate = [];
	candidate[1] = [text];
	candidate[8] = [2];
	candidate[12] = [];
	candidate[12][7] = [[generatedImageEntry(url)]];
	return candidate;
}

describe("Gemini generated-image transport", () => {
	beforeEach(resetGeminiBuildLabelCacheForTest);
	afterEach(resetGeminiBuildLabelCacheForTest);
	test("keeps StreamGenerate on socket while generated image bytes use fetch", async () => {
		const cfg = baseGeminiClientConfig({ upstream_socket: true });
		const imageUrl =
			"https://lh3.googleusercontent.com/gg-dl/AFfU-direct-image";
		const raw = richWrbLine(generatedImageCandidate("", imageUrl));
		const socketState = {};
		const socketResponse = `HTTP/1.1 200 OK\r\nContent-Length: ${new TextEncoder().encode(raw).byteLength}\r\n\r\n${raw}`;
		_setConnectForTest(fakeSocketConnect([socketResponse], socketState));
		const fetchCalls = [];
		try {
			await withFetch(
				async (url) => {
					fetchCalls.push(String(url));
					if (String(url) === imageUrl) {
						return new Response(base64ToBytes(TINY_PNG_BASE64), {
							status: 200,
							headers: { "content-type": "image/png" },
						});
					}
					throw new Error(`unexpected fetch ${String(url)}`);
				},
				async () => {
					const rich = await generateRich(cfg, "draw image", 1, false, null);
					assert.equal(rich.images.length, 1);
					assert.equal(rich.images[0].base64, TINY_PNG_BASE64);
				},
			);
		} finally {
			_setConnectForTest(null);
		}
		const socketRequestText = socketState.writes
			.map((chunk) => new TextDecoder().decode(chunk))
			.join("");
		assert.match(socketRequestText, /StreamGenerate/);
		assert.doesNotMatch(socketRequestText, /gg-dl/);
		assert.deepEqual(fetchCalls, [imageUrl]);
	});
});
