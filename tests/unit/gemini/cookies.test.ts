// @ts-nocheck
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	configWithActiveGeminiCookie,
	mergeSetCookieHeaders,
	observeGeminiAccountResponseCookies,
	parseCookieHeader,
	resetActiveGeminiCookieForTest,
	rotateGeminiCookieForRetry,
	rotateGeminiCookieForRetryWithReason,
	splitSetCookieHeader,
} from "../../../src/gemini/cookies";
import {
	getPageTokens,
	resetGeminiUploadCachesForTest,
} from "../../../src/gemini/uploads/tokens";
import { assert } from "../assertions.js";
import { withFetch } from "../_support/globals.js";

describe("Gemini cookies", () => {
	beforeEach(resetActiveGeminiCookieForTest);
	afterEach(resetActiveGeminiCookieForTest);
	test("parses and merges cookie headers with quoted values", () => {
		const parsed = Object.fromEntries(
			parseCookieHeader("SID=ok; SAPISID=sapi; __Secure-1PSID=psid"),
		);
		assert.deepEqual(parsed, {
			SID: "ok",
			SAPISID: "sapi",
			"__Secure-1PSID": "psid",
		});

		const split = splitSetCookieHeader(
			[
				"__Secure-1PSIDTS=new; Path=/; Secure",
				"NID=x; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
			].join(", "),
		);
		assert.equal(split.length, 2);

		const merged = mergeSetCookieHeaders(
			"__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
			split,
		);
		assert.equal(
			merged,
			"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi; NID=x",
		);

		const quoted = splitSetCookieHeader(
			[
				'A="x,y"; Path=/',
				"B=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
				"C=3; Path=/",
			].join(", "),
		);
		assert.deepEqual(quoted, [
			'A="x,y"; Path=/',
			"B=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
			"C=3; Path=/",
		]);
	});
	test("derives active Gemini cookie config without mutating input", () => {
		const cfg = {
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
			sapisid: "",
		};
		const active = configWithActiveGeminiCookie(cfg);
		assert.equal(
			active.cookie,
			"__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
		);
		assert.equal(active.sapisid, "sapi");
		assert.equal(cfg.sapisid, "");
	});
	test("observes Set-Cookie only from successful managed-account responses", () => {
		const observed = [];
		const cfg = {
			gemini_account: {
				observeSetCookie(values) {
					observed.push([...values]);
				},
			},
		};
		observeGeminiAccountResponseCookies(
			cfg,
			new Response("", {
				status: 200,
				headers: { "set-cookie": "__Secure-1PSIDTS=accepted" },
			}),
		);
		observeGeminiAccountResponseCookies(
			cfg,
			new Response("", {
				status: 500,
				headers: { "set-cookie": "__Secure-1PSIDTS=ignored" },
			}),
		);
		assert.deepEqual(observed, [["__Secure-1PSIDTS=accepted"]]);
	});
	test("rotates Gemini cookie with safe RotateCookies headers", async () => {
		let calls = 0;
		const cfg = {
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
			sapisid: "",
			request_timeout_sec: 180,
			upstream_socket: false,
			log_requests: false,
		};
		await withFetch(
			async (url, init) => {
				calls += 1;
				assert.equal(String(url), "https://accounts.google.com/RotateCookies");
				assert.equal(init.method, "POST");
				assert.equal(init.headers.Cookie, cfg.cookie);
				assert.equal(init.headers.Origin, "https://accounts.google.com");
				assert.equal(init.headers.Referer, "https://accounts.google.com/");
				assert.equal(init.headers["Accept-Language"], "en-US,en;q=0.9");
				assert.match(init.headers["User-Agent"], /Mozilla\/5\.0/);
				return new Response("", {
					status: 200,
					headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
				});
			},
			async () => {
				const rotated = await rotateGeminiCookieForRetry(cfg);
				assert.equal(calls, 1);
				assert.equal(
					rotated.cookie,
					"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
				);
				assert.equal(rotated.sapisid, "sapi");
			},
		);
	});
	test("debounces failed cookie rotation after upstream rejection", async () => {
		const cfg = {
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
			sapisid: "",
			request_timeout_sec: 180,
			upstream_socket: false,
			log_requests: false,
		};
		await withFetch(
			async (url, init) => {
				assert.equal(String(url), "https://accounts.google.com/RotateCookies");
				assert.equal(init.method, "POST");
				return new Response("", { status: 401 });
			},
			async () => {
				assert.equal(await rotateGeminiCookieForRetry(cfg), null);
				const rotated = await rotateGeminiCookieForRetryWithReason(cfg);
				assert.equal(rotated.config, null);
				assert.equal(rotated.reason, "recent_rotation");
			},
		);
	});
	test("rejects cookie rotation when no updated cookie returns", async () => {
		const cfg = {
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
			sapisid: "",
			request_timeout_sec: 180,
			upstream_socket: false,
			log_requests: false,
		};
		await withFetch(
			async (url, init) => {
				assert.equal(String(url), "https://accounts.google.com/RotateCookies");
				assert.equal(init.method, "POST");
				return new Response("", { status: 200 });
			},
			async () => {
				assert.equal(await rotateGeminiCookieForRetry(cfg), null);
			},
		);
	});
	test("coalesces concurrent cookie rotation requests", async () => {
		let calls = 0;
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const cfg = {
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
			sapisid: "",
			request_timeout_sec: 180,
			upstream_socket: false,
			log_requests: false,
		};
		await withFetch(
			async (url, init) => {
				calls += 1;
				assert.equal(String(url), "https://accounts.google.com/RotateCookies");
				assert.equal(init.method, "POST");
				await gate;
				return new Response("", {
					status: 200,
					headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
				});
			},
			async () => {
				const first = rotateGeminiCookieForRetry(cfg);
				const second = rotateGeminiCookieForRetry(cfg);
				release();
				const results = await Promise.all([first, second]);
				assert.equal(calls, 1);
				assert.equal(
					results[0].cookie,
					"__Secure-1PSID=psid; __Secure-1PSIDTS=new",
				);
				assert.equal(
					results[1].cookie,
					"__Secure-1PSID=psid; __Secure-1PSIDTS=new",
				);
			},
		);
	});
	test("reports rejected cookie rotation reason and upstream status", async () => {
		const cfg = {
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
			sapisid: "",
			request_timeout_sec: 180,
			upstream_socket: false,
			log_requests: false,
		};
		await withFetch(
			async (url, init) => {
				assert.equal(String(url), "https://accounts.google.com/RotateCookies");
				assert.equal(init.method, "POST");
				return new Response("", { status: 403 });
			},
			async () => {
				const rotated = await rotateGeminiCookieForRetryWithReason(cfg);
				assert.equal(rotated.config, null);
				assert.equal(rotated.reason, "rotation_rejected");
				assert.equal(rotated.upstreamStatus, 403);
			},
		);
	});
	test("invalidates page token cache after cookie rotation", async () => {
		resetGeminiUploadCachesForTest();
		try {
			const cfg = {
				gemini_origin: "https://gemini.example",
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			const pageCookies = [];
			let appCalls = 0;
			await withFetch(
				async (url, init) => {
					const href = String(url);
					if (href === "https://gemini.example/app") {
						appCalls += 1;
						pageCookies.push(init.headers.Cookie);
						return new Response(`{"SNlM0e":"at-${appCalls}"}`, { status: 200 });
					}
					if (href === "https://accounts.google.com/RotateCookies") {
						return new Response("", {
							status: 200,
							headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
						});
					}
					throw new Error(`unexpected fetch ${href}`);
				},
				async () => {
					const first = await getPageTokens(cfg);
					assert.equal(first.at, "at-1");
					const rotated = await rotateGeminiCookieForRetry(cfg);
					assert.equal(
						rotated.cookie,
						"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
					);
					const second = await getPageTokens(cfg);
					assert.equal(second.at, "at-2");
					assert.deepEqual(pageCookies, [
						"__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
						"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
					]);
					assert.equal(appCalls, 2);
				},
			);
		} finally {
			resetGeminiUploadCachesForTest();
		}
	});
	test("deduplicates repeated active cookie names", () => {
		const active = configWithActiveGeminiCookie({
			cookie:
				"__Secure-1PSID=psid; __Secure-1PSIDTS=old; __Secure-1PSIDTS=new; SAPISID=sapi",
			sapisid: "",
		});
		assert.equal(
			active.cookie,
			"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
		);
	});
});
