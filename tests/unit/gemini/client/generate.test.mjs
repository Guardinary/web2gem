import { afterEach, beforeEach, describe, test } from "vitest";
import { generate } from "../../../../src/gemini/client";
import { resetGeminiBuildLabelCacheForTest } from "../../../../src/gemini/client/retry";
import { resetActiveGeminiCookieForTest } from "../../../../src/gemini/cookies";
import { resetGeminiUploadCachesForTest } from "../../../../src/gemini/uploads/tokens";
import { assert } from "../../assertions.js";
import { withFetch } from "../../helpers.js";
import { baseGeminiClientConfig } from "../_support/client-fixtures.js";

function wrbLine(texts) {
	const inner = [null, null, null, null, [[null, texts]], "x".repeat(160)];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

function resetGenerateClientState() {
	resetGeminiBuildLabelCacheForTest();
	resetActiveGeminiCookieForTest();
	resetGeminiUploadCachesForTest();
}

describe("Gemini client generation", () => {
	beforeEach(resetGenerateClientState);
	afterEach(resetGenerateClientState);
	test("observes managed account cookies from generation responses", async () => {
		const observed = [];
		const cfg = baseGeminiClientConfig({
			gemini_account: {
				accountId: "managed",
				cookieHash: "managed-hash",
				observeSetCookie(values) {
					observed.push([...values]);
				},
			},
		});
		await withFetch(
			async (url) => {
				const href = String(url);
				assert.match(href, /StreamGenerate/);
				return new Response(wrbLine(["observed"]), {
					status: 200,
					headers: {
						"set-cookie": "__Secure-1PSIDTS=from-generation; Path=/; Secure",
					},
				});
			},
			async () => {
				assert.equal(await generate(cfg, "prompt", 1, false, null), "observed");
			},
		);
		assert.equal(observed.length, 1);
		assert.match(observed[0][0], /from-generation/);
	});
	test("generates text with page auth token appended for cookie requests", async () => {
		const calls = [];
		const cfg = baseGeminiClientConfig({
			cookie: "__Secure-1PSID=psid; SAPISID=sapi",
			sapisid: "sapi",
		});
		await withFetch(
			async (url, init = {}) => {
				calls.push({ url: String(url), init });
				if (String(url) === "https://gemini.example/app") {
					return new Response('{"SNlM0e":"at-test"}', { status: 200 });
				}
				assert.match(String(url), /StreamGenerate/);
				assert.match(String(init.body), /&at=at-test/);
				return new Response(
					[
						JSON.stringify([
							[
								"wrb.fr",
								null,
								JSON.stringify([
									null,
									null,
									null,
									null,
									[[null, ["hello"]]],
									"x".repeat(160),
								]),
							],
						]),
					].join("\n"),
					{ status: 200 },
				);
			},
			async () => {
				const text = await generate(cfg, "prompt", 1, false, null);
				assert.equal(text, "hello");
			},
		);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].init.headers.Cookie, cfg.cookie);
	});
	test("rejects cookie requests when Gemini page auth token is missing", async () => {
		const calls = [];
		const cfg = baseGeminiClientConfig({ cookie: "SID=ok" });
		await withFetch(
			async (url) => {
				calls.push(String(url));
				if (String(url) === "https://gemini.example/app")
					return new Response("<html>no at token</html>", { status: 200 });
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				try {
					await generate(cfg, "prompt", 1, false, null);
					throw new Error("expected missing page token failure");
				} catch (err) {
					assert.equal(err.code, "invalid_gemini_cookie");
					assert.match(err.message, /Gemini account pool/);
				}
			},
		);
		assert.deepEqual(calls, ["https://gemini.example/app"]);
	});
	test("reports cookie rotation failure when StreamGenerate rejects the cookie", async () => {
		const calls = [];
		const cfg = baseGeminiClientConfig({
			cookie: "__Secure-1PSID=psid; SAPISID=sapi",
			sapisid: "sapi",
		});
		await withFetch(
			async (url) => {
				const href = String(url);
				calls.push(href);
				if (href === "https://gemini.example/app")
					return new Response('{"SNlM0e":"at-test"}', { status: 200 });
				if (href === "https://accounts.google.com/RotateCookies")
					return new Response("", { status: 200 });
				assert.match(href, /StreamGenerate/);
				return new Response("rejected", { status: 401 });
			},
			async () => {
				try {
					await generate(cfg, "prompt", 1, false, null);
					throw new Error("expected invalid cookie failure");
				} catch (err) {
					assert.equal(err.code, "invalid_gemini_cookie");
					assert.equal(
						err.reason,
						"RotateCookies completed but did not return an updated cookie",
					);
					assert.equal(err.upstreamStatus, 401);
				}
			},
		);
		assert.equal(
			calls.some(
				(href) => href === "https://accounts.google.com/RotateCookies",
			),
			true,
		);
	});
	test("retries generate after successful cookie rotation", async () => {
		const calls = [];
		let appCalls = 0;
		let streamCalls = 0;
		const cfg = baseGeminiClientConfig({
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
			retry_attempts: 2,
		});
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				calls.push({
					href,
					cookie: init.headers?.Cookie,
					body: String(init.body || ""),
				});
				if (href === "https://gemini.example/app") {
					appCalls += 1;
					return new Response(`{"SNlM0e":"at-${appCalls}"}`, { status: 200 });
				}
				if (href === "https://accounts.google.com/RotateCookies") {
					assert.match(init.headers.Cookie, /__Secure-1PSIDTS=old/);
					return new Response("", {
						status: 200,
						headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
					});
				}
				assert.match(href, /StreamGenerate/);
				streamCalls += 1;
				if (streamCalls === 1)
					return new Response("cookie rejected", { status: 401 });
				assert.match(init.headers.Cookie, /__Secure-1PSIDTS=new/);
				assert.match(String(init.body), /&at=at-2/);
				return new Response(wrbLine(["after cookie rotation"]), {
					status: 200,
				});
			},
			async () => {
				const text = await generate(cfg, "prompt", 1, false, null);
				assert.equal(text, "after cookie rotation");
			},
		);
		assert.equal(streamCalls, 2);
		assert.equal(
			calls.some(
				(call) => call.href === "https://accounts.google.com/RotateCookies",
			),
			true,
		);
	});
	test("refreshes Gemini build label and retries empty non-stream responses", async () => {
		const cfg = baseGeminiClientConfig({
			gemini_bl: "old-bl",
			retry_attempts: 2,
		});
		const streamUrls = [];
		await withFetch(
			async (url) => {
				const href = String(url);
				if (href === "https://gemini.example/app") {
					return new Response('<html>{"cfb2h":"fresh-bl"}</html>', {
						status: 200,
					});
				}
				assert.match(href, /StreamGenerate/);
				streamUrls.push(href);
				if (streamUrls.length === 1)
					return new Response("no parseable text", { status: 200 });
				return new Response(wrbLine(["after refresh"]), { status: 200 });
			},
			async () => {
				const text = await generate(cfg, "prompt", 1, false, null);
				assert.equal(text, "after refresh");
			},
		);
		assert.match(streamUrls[0], /bl=old-bl/);
		assert.match(streamUrls[1], /bl=fresh-bl/);
	});
	test("throws explicit non-stream upstream error when refresh cannot recover", async () => {
		const cfg = baseGeminiClientConfig({ gemini_bl: "stale-bl" });
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
				return new Response("upstream failure without wrb text", {
					status: 502,
				});
			},
			async () => {
				try {
					await generate(cfg, "prompt", 1, false, null);
					throw new Error("expected non-stream upstream failure");
				} catch (err) {
					assert.match(err.message, /HTTP 502 returned no parseable text/);
				}
			},
		);
		assert.equal(calls.length, 2);
		assert.match(calls[0], /StreamGenerate/);
		assert.equal(calls[1], "https://gemini.example/app");
	});
	test("throws explicit non-stream upstream empty error for HTTP 200 responses", async () => {
		const cfg = baseGeminiClientConfig({ gemini_bl: "stale-bl" });
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
				return new Response("upstream completed without wrb text", {
					status: 200,
				});
			},
			async () => {
				try {
					await generate(cfg, "prompt", 1, false, null);
					throw new Error("expected upstream empty response");
				} catch (err) {
					assert.equal(err.code, "upstream_empty_response");
					assert.equal(err.status, 502);
					assert.equal(err.upstreamStatus, 200);
					assert.equal(
						err.rawLength,
						"upstream completed without wrb text".length,
					);
				}
			},
		);
		assert.equal(calls.length, 2);
		assert.match(calls[0], /StreamGenerate/);
		assert.equal(calls[1], "https://gemini.example/app");
	});
	test("classifies data-analysis empty responses for uploaded files", async () => {
		const cfg = baseGeminiClientConfig();
		let calls = 0;
		await withFetch(
			async (url) => {
				calls += 1;
				assert.match(String(url), /StreamGenerate/);
				return new Response("data_analysis_tool returned no final text", {
					status: 200,
				});
			},
			async () => {
				try {
					await generate(cfg, "prompt", 1, false, [
						{ ref: "file-ref", name: "data.csv" },
					]);
					throw new Error("expected data-analysis empty response");
				} catch (err) {
					assert.equal(err.code, "data_analysis_empty_response");
					assert.match(err.message, /data_analysis_tool/);
				}
			},
		);
		assert.equal(calls, 1);
	});
	test("classifies large prompt empty responses before generic retry exhaustion", async () => {
		const cfg = baseGeminiClientConfig({
			current_input_file_min_bytes: 10,
		});
		let calls = 0;
		await withFetch(
			async (url) => {
				calls += 1;
				assert.match(String(url), /StreamGenerate/);
				return new Response("no parseable text", { status: 200 });
			},
			async () => {
				try {
					await generate(cfg, "x".repeat(20), 1, false, null);
					throw new Error("expected large prompt empty response");
				} catch (err) {
					assert.equal(err.code, "large_prompt_empty_response");
					assert.equal(err.thresholdBytes, 10);
					assert.equal(err.promptBytes > err.thresholdBytes, true);
				}
			},
		);
		assert.equal(calls, 1);
	});
});
