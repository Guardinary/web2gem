// @ts-nocheck
import { afterEach, beforeEach, describe, test } from "vitest";
import { generateStream } from "../../../../src/gemini/client";
import { resetGeminiBuildLabelCacheForTest } from "../../../../src/gemini/client/retry";
import { assert } from "../../assertions.js";
import { withFetch } from "../../_support/globals.js";
import { baseGeminiClientConfig } from "../_support/client-fixtures.js";

function wrbLine(texts) {
	const inner = [null, null, null, null, [[null, texts]], "x".repeat(160)];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

describe("Gemini client streaming", () => {
	beforeEach(resetGeminiBuildLabelCacheForTest);
	afterEach(resetGeminiBuildLabelCacheForTest);
	test("aborts Gemini streams before starting upstream fetch", async () => {
		const cfg = baseGeminiClientConfig();
		const ac = new AbortController();
		ac.abort("stop now");
		await withFetch(
			async () => {
				throw new Error("fetch should not run");
			},
			async () => {
				try {
					for await (const _delta of generateStream(
						cfg,
						"prompt",
						1,
						false,
						null,
						{ signal: ac.signal },
					)) {
						throw new Error("stream should not yield");
					}
					throw new Error("expected abort");
				} catch (err) {
					assert.equal(err.name, "AbortError");
					assert.equal(err.code, "request_aborted");
					assert.match(err.message, /stop now/);
				}
			},
		);
	});
	test("throws for stream responses with no body and no parseable fallback text", async () => {
		const cfg = baseGeminiClientConfig();
		const calls = [];
		await withFetch(
			async (url) => {
				const href = String(url);
				calls.push(href);
				if (href === "https://gemini.example/app")
					return new Response("<html>no fresh build label</html>", {
						status: 200,
					});
				assert.match(href, /StreamGenerate/);
				return new Response(null, { status: 502 });
			},
			async () => {
				try {
					for await (const _delta of generateStream(
						cfg,
						"prompt",
						1,
						false,
						null,
					)) {
						throw new Error("stream should not yield");
					}
					throw new Error("expected empty stream error");
				} catch (err) {
					assert.equal(err.code, "upstream_empty_response");
					assert.equal(err.status, 502);
					assert.equal(err.upstreamStatus, 502);
					assert.equal(err.rawLength, 0);
				}
			},
		);
		assert.equal(calls.length, 2);
		assert.match(calls[0], /StreamGenerate/);
		assert.equal(calls[1], "https://gemini.example/app");
	});
	test("streams a final unterminated WRB line from the response body", async () => {
		const cfg = baseGeminiClientConfig();
		await withFetch(
			async (url) => {
				assert.match(String(url), /StreamGenerate/);
				return new Response(
					JSON.stringify([
						[
							"wrb.fr",
							null,
							JSON.stringify([
								null,
								null,
								null,
								null,
								[[null, ["stream fallback"]]],
								"x".repeat(160),
							]),
						],
					]),
					{ status: 200 },
				);
			},
			async () => {
				const chunks = [];
				for await (const delta of generateStream(cfg, "prompt", 1, false, null))
					chunks.push(delta);
				assert.deepEqual(chunks, ["stream fallback"]);
			},
		);
	});
	test("streams fallback text from response-like objects with no body", async () => {
		const cfg = baseGeminiClientConfig();
		await withFetch(
			async (url) => {
				assert.match(String(url), /StreamGenerate/);
				return {
					ok: true,
					status: 200,
					body: null,
					async text() {
						return wrbLine(["response-like fallback"]);
					},
				};
			},
			async () => {
				const chunks = [];
				for await (const delta of generateStream(cfg, "prompt", 1, false, null))
					chunks.push(delta);
				assert.deepEqual(chunks, ["response-like fallback"]);
			},
		);
	});
	test("throws when streamed Gemini body has no parseable text", async () => {
		const cfg = baseGeminiClientConfig();
		const calls = [];
		await withFetch(
			async (url) => {
				const href = String(url);
				calls.push(href);
				if (href === "https://gemini.example/app")
					return new Response("<html>no fresh build label</html>", {
						status: 200,
					});
				assert.match(href, /StreamGenerate/);
				return new Response("not parseable", { status: 502 });
			},
			async () => {
				try {
					for await (const _delta of generateStream(
						cfg,
						"prompt",
						1,
						false,
						null,
					)) {
						throw new Error("stream should not yield");
					}
					throw new Error("expected parse failure");
				} catch (err) {
					assert.equal(err.code, "upstream_empty_response");
					assert.equal(err.status, 502);
					assert.equal(err.upstreamStatus, 502);
					assert.equal(err.rawLength, "not parseable".length);
				}
			},
		);
		assert.equal(calls.length, 2);
		assert.match(calls[0], /StreamGenerate/);
		assert.equal(calls[1], "https://gemini.example/app");
	});
	test("throws explicit stream upstream empty error for HTTP 200 responses", async () => {
		const cfg = baseGeminiClientConfig({ gemini_bl: "stale-stream-bl" });
		const calls = [];
		await withFetch(
			async (url) => {
				const href = String(url);
				calls.push(href);
				if (href === "https://gemini.example/app")
					return new Response("<html>no fresh build label</html>", {
						status: 200,
					});
				assert.match(href, /StreamGenerate/);
				return new Response("stream completed without wrb text", {
					status: 200,
				});
			},
			async () => {
				try {
					for await (const _delta of generateStream(
						cfg,
						"prompt",
						1,
						false,
						null,
					)) {
						throw new Error("stream should not yield");
					}
					throw new Error("expected upstream empty stream response");
				} catch (err) {
					assert.equal(err.code, "upstream_empty_response");
					assert.equal(err.status, 502);
					assert.equal(err.upstreamStatus, 200);
					assert.equal(
						err.rawLength,
						"stream completed without wrb text".length,
					);
				}
			},
		);
		assert.equal(calls.length, 2);
		assert.match(calls[0], /StreamGenerate/);
		assert.equal(calls[1], "https://gemini.example/app");
	});
	test("refreshes Gemini build label and retries empty stream bodies", async () => {
		const cfg = baseGeminiClientConfig({
			gemini_bl: "old-stream-bl",
			retry_attempts: 2,
		});
		const streamUrls = [];
		await withFetch(
			async (url) => {
				const href = String(url);
				if (href === "https://gemini.example/app")
					return new Response('<html>{"cfb2h":"fresh-stream-bl"}</html>', {
						status: 200,
					});
				assert.match(href, /StreamGenerate/);
				streamUrls.push(href);
				if (streamUrls.length === 1)
					return new Response("not parseable yet", { status: 200 });
				return new Response(wrbLine(["after stream refresh"]), {
					status: 200,
				});
			},
			async () => {
				const chunks = [];
				for await (const delta of generateStream(cfg, "prompt", 1, false, null))
					chunks.push(delta);
				assert.deepEqual(chunks, ["after stream refresh"]);
			},
		);
		assert.match(streamUrls[0], /bl=old-stream-bl/);
		assert.match(streamUrls[1], /bl=fresh-stream-bl/);
	});
});
