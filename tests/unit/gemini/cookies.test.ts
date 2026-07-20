import { afterEach, beforeEach, describe, test } from "vitest";
import type { RuntimeConfig } from "../../../src/config";
import {
	configWithActiveGeminiCookie,
	mergeSetCookieHeaders,
	observeGeminiAccountResponseCookies,
	parseCookieHeader,
	resetActiveGeminiCookieForTest,
	rotateGeminiCookieForRetryWithReason,
} from "../../../src/gemini/cookies";
import {
	getPageTokens,
	resetGeminiUploadCachesForTest,
} from "../../../src/gemini/uploads/tokens";
import { withFetch } from "../_support/globals.js";
import { assert } from "../assertions.js";
import { baseGeminiClientConfig } from "./_support/client-fixtures.js";

type CookieFetchInit = RequestInit & { headers: Record<string, string> };
function cookieConfig(overrides: Partial<RuntimeConfig>): RuntimeConfig {
	return baseGeminiClientConfig(overrides);
}

describe("Gemini cookies", () => {
	beforeEach(resetActiveGeminiCookieForTest);
	afterEach(resetActiveGeminiCookieForTest);
	test("parses and merges cookie headers", () => {
		const parsed = Object.fromEntries(
			parseCookieHeader("SID=ok; SAPISID=sapi; __Secure-1PSID=psid"),
		);
		assert.deepEqual(parsed, {
			SID: "ok",
			SAPISID: "sapi",
			"__Secure-1PSID": "psid",
		});

		const setCookieValues = [
			"__Secure-1PSIDTS=new; Path=/; Secure",
			"NID=x; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
		];

		const merged = mergeSetCookieHeaders(
			"__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
			setCookieValues,
		);
		assert.equal(
			merged,
			"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi; NID=x",
		);
	});
	test("derives active Gemini cookie config without mutating input", () => {
		const cfg = cookieConfig({
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
			sapisid: "",
		});
		const active = configWithActiveGeminiCookie(cfg);
		assert.equal(
			active.cookie,
			"__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
		);
		assert.equal(active.sapisid, "sapi");
		assert.equal(cfg.sapisid, "");
	});
	test("observes Set-Cookie only from successful managed-account responses", () => {
		const observed: string[][] = [];
		const cfg = baseGeminiClientConfig({
			gemini_account: {
				accountId: "cookie-test",
				cookieHash: "cookie-hash",
				observeSetCookie(values: readonly string[]) {
					observed.push([...values]);
				},
			},
		});
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
		const cfg = cookieConfig({
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
			sapisid: "",
			request_timeout_sec: 180,
			upstream_socket: false,
			log_requests: false,
		});
		await withFetch(
			async (url: RequestInfo | URL, init: CookieFetchInit) => {
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
				const rotated = await rotateGeminiCookieForRetryWithReason(cfg);
				if (!rotated.config) throw new Error("expected rotated config");
				assert.equal(calls, 1);
				assert.equal(
					rotated.config.cookie,
					"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
				);
				assert.equal(rotated.config.sapisid, "sapi");
			},
		);
	});
	test("debounces failed cookie rotation after upstream rejection", async () => {
		const cfg = cookieConfig({
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
			sapisid: "",
			request_timeout_sec: 180,
			upstream_socket: false,
			log_requests: false,
		});
		await withFetch(
			async (url: RequestInfo | URL, init: CookieFetchInit) => {
				assert.equal(String(url), "https://accounts.google.com/RotateCookies");
				assert.equal(init.method, "POST");
				return new Response("", { status: 401 });
			},
			async () => {
				assert.equal(
					(await rotateGeminiCookieForRetryWithReason(cfg)).config,
					null,
				);
				const rotated = await rotateGeminiCookieForRetryWithReason(cfg);
				assert.equal(rotated.config, null);
				assert.equal(rotated.reason, "recent_rotation");
			},
		);
	});
	test("rejects cookie rotation when no updated cookie returns", async () => {
		const cfg = cookieConfig({
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
			sapisid: "",
			request_timeout_sec: 180,
			upstream_socket: false,
			log_requests: false,
		});
		await withFetch(
			async (url: RequestInfo | URL, init: CookieFetchInit) => {
				assert.equal(String(url), "https://accounts.google.com/RotateCookies");
				assert.equal(init.method, "POST");
				return new Response("", { status: 200 });
			},
			async () => {
				assert.equal(
					(await rotateGeminiCookieForRetryWithReason(cfg)).config,
					null,
				);
			},
		);
	});
	test("coalesces concurrent cookie rotation requests", async () => {
		let calls = 0;
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const cfg = cookieConfig({
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
			sapisid: "",
			request_timeout_sec: 180,
			upstream_socket: false,
			log_requests: false,
		});
		await withFetch(
			async (url: RequestInfo | URL, init: CookieFetchInit) => {
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
				const first = rotateGeminiCookieForRetryWithReason(cfg);
				const second = rotateGeminiCookieForRetryWithReason(cfg);
				release();
				const results = await Promise.all([first, second]);
				const [firstResult, secondResult] = results;
				if (!firstResult?.config || !secondResult?.config)
					throw new Error("expected coalesced rotated configs");
				assert.equal(calls, 1);
				assert.equal(
					firstResult.config.cookie,
					"__Secure-1PSID=psid; __Secure-1PSIDTS=new",
				);
				assert.equal(
					secondResult.config.cookie,
					"__Secure-1PSID=psid; __Secure-1PSIDTS=new",
				);
			},
		);
	});
	test("reports rejected cookie rotation reason and upstream status", async () => {
		const cfg = cookieConfig({
			cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
			sapisid: "",
			request_timeout_sec: 180,
			upstream_socket: false,
			log_requests: false,
		});
		await withFetch(
			async (url: RequestInfo | URL, init: CookieFetchInit) => {
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
			const cfg = cookieConfig({
				gemini_origin: "https://gemini.example",
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			});
			const pageCookies: string[] = [];
			let appCalls = 0;
			await withFetch(
				async (url: RequestInfo | URL, init: CookieFetchInit) => {
					const href = String(url);
					if (href === "https://gemini.example/app") {
						appCalls += 1;
						const cookie = init.headers.Cookie;
						if (!cookie) throw new Error("expected Cookie header");
						pageCookies.push(cookie);
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
					const rotated = await rotateGeminiCookieForRetryWithReason(cfg);
					if (!rotated.config) throw new Error("expected rotated config");
					assert.equal(
						rotated.config.cookie,
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
		const active = configWithActiveGeminiCookie(
			cookieConfig({
				cookie:
					"__Secure-1PSID=psid; __Secure-1PSIDTS=old; __Secure-1PSIDTS=new; SAPISID=sapi",
				sapisid: "",
			}),
		);
		assert.equal(
			active.cookie,
			"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
		);
	});
});
