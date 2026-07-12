import { assert } from "./assertions.js";
import {
	fakePersistentSocketConnect,
	fakeSocketConnect,
	joinedWriteText,
	mod,
	withConsoleLog,
	withFetch,
	withPatchedGlobal,
} from "./helpers.js";

export const suiteName = "runtime core";
export const cases = [
	[
		"bounds prompt byte length without full exact count",
		async () => {
			const bounded = mod.promptByteLengthBounded("x".repeat(100), 10);
			assert.equal(bounded.exceeded, true);
			assert.equal(bounded.exact, false);
			assert.equal(bounded.bytes, 11);
		},
	],
	[
		"counts split surrogate pairs exactly in prompt sniffer",
		async () => {
			const sniffer = mod.createPromptByteLengthSniffer(4);
			sniffer.append("\uD83D");
			sniffer.append("\uDE00");
			assert.deepEqual(sniffer.result(), {
				bytes: 4,
				exceeded: false,
				exact: true,
				maxBytes: 4,
			});
		},
	],
	[
		"counts token and prompt byte edges for mixed Unicode text",
		async () => {
			assert.deepEqual(mod.tokenCharCounts("abcd😀中"), {
				asciiChars: 4,
				nonASCIIChars: 2,
			});
			assert.equal(mod.tokenEst("abcd😀中") >= 2, true);
			assert.equal(mod.promptByteLength("aé中😀\uD83D"), 13);
			assert.deepEqual(mod.promptByteLengthBounded("éé", 3), {
				bytes: 4,
				exceeded: true,
				exact: false,
				maxBytes: 3,
			});
			assert.equal(mod.promptByteLengthGreaterThan("abcd", 3), true);

			const counter = mod.createTokenCounter();
			counter.append("abcd");
			counter.append("\uD83D");
			counter.append("\uDE00中");
			assert.deepEqual(counter.counts(), {
				asciiChars: 4,
				nonASCIIChars: 2,
				hasText: true,
			});
			assert.equal(counter.tokens(), mod.tokenEst("abcd😀中"));
		},
	],
	[
		"finalizes pending high surrogates in prompt byte sniffers",
		async () => {
			const exact = mod.createPromptByteLengthSniffer(3);
			exact.append("\uD83D");
			assert.equal(exact.exceeded(), false);
			assert.deepEqual(exact.result(), {
				bytes: 3,
				exceeded: false,
				exact: true,
				maxBytes: 3,
			});

			const exceeded = mod.createPromptByteLengthSniffer(3);
			exceeded.append("\uD83D");
			exceeded.append("\uDE00");
			assert.equal(exceeded.exceeded(), true);
			assert.deepEqual(exceeded.result(), {
				bytes: 4,
				exceeded: true,
				exact: false,
				maxBytes: 3,
			});
		},
	],
	[
		"builds token text without retaining text and measures code points",
		async () => {
			const prepared = mod.buildTextWithTokens(
				["ab", null, ["cd"], "😀"],
				false,
			);
			assert.equal(prepared.text, "");
			assert.deepEqual(prepared.counts, {
				asciiChars: 4,
				nonASCIIChars: 1,
				hasText: true,
			});
			assert.equal(mod.codePointLength("a😀中"), 3);
			assert.equal(mod.codePointLengthAtLeast("a😀", 2), true);
			assert.equal(mod.codePointLengthAtLeast("a😀", 3), false);
		},
	],
	[
		"trims repeated stream continuation overlap conservatively",
		async () => {
			assert.equal(mod.trimContinuationOverlap("", "hello"), "hello");
			assert.equal(mod.trimContinuationOverlap("hello", ""), "");
			assert.equal(
				mod.trimContinuationOverlap("hello", "hello world"),
				" world",
			);
			assert.equal(mod.trimContinuationOverlap("hello world", "hello"), "");
			assert.equal(mod.trimContinuationOverlap("hello", "yellow"), "yellow");
		},
	],
	[
		"logs runtime messages and stage metadata behind config flag",
		async () => {
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					mod.log(null, "hidden");
					mod.log({ log_requests: false }, "hidden");
					mod.log({ log_requests: true }, { ok: true });
					const cyclic = {};
					cyclic.self = cyclic;
					mod.log({ log_requests: true }, cyclic);
					mod.logStage({ log_requests: true }, "upload", {
						empty: "",
						skip: null,
						n: 0,
						ok: false,
						name: "message.txt",
					});
					mod.logStage(null, "hidden");
				},
			);
			assert.equal(logs.length, 3);
			assert.match(logs[0], /\[web2gem\] \{"ok":true\}/);
			assert.match(logs[1], /\[object Object\]/);
			assert.match(logs[2], /stage=upload/);
			assert.match(logs[2], /n=0/);
			assert.match(logs[2], /ok=false/);
			assert.match(logs[2], /name=message\.txt/);
			assert.doesNotMatch(logs[2], /empty=/);
			await withConsoleLog(
				() => {
					throw new Error("console unavailable");
				},
				async () => {
					mod.log({ log_requests: true }, "safe");
				},
			);
		},
	],
	[
		"handles runtime abort and timeout edges",
		async () => {
			await mod.sleep(0);
			assert.equal(mod.timeoutSignal("not-a-number"), undefined);
			assert.equal(mod.timeoutSignal(0), undefined);
			assert.equal(typeof mod.timeoutSignal(1)?.aborted, "boolean");

			const already = new AbortController();
			already.abort("already done");
			try {
				mod.throwIfAborted(already.signal);
				throw new Error("expected throwIfAborted to throw");
			} catch (err) {
				assert.equal(err.name, "AbortError");
				assert.equal(err.code, "request_aborted");
				assert.match(err.message, /already done/);
			}
			await assert.rejects(() => mod.sleep(0, already.signal), /already done/);

			const during = new AbortController();
			const pending = mod.sleep(1000, during.signal);
			during.abort("later done");
			await assert.rejects(pending, /later done/);
			assert.equal(mod.isAbortError({ code: "request_aborted" }), true);
			assert.equal(mod.isAbortError({ name: "AbortError" }), true);
			assert.equal(mod.isAbortError(new Error("plain")), false);
		},
	],
	[
		"uses native AbortSignal.any for fetch timeout linking",
		async () => {
			const originalAny = AbortSignal.any;
			let calls = 0;
			let seenSignals = null;
			Object.defineProperty(AbortSignal, "any", {
				configurable: true,
				value(signals) {
					calls++;
					seenSignals = Array.from(signals);
					return originalAny.call(AbortSignal, signals);
				},
			});
			try {
				const ac = new AbortController();
				await withFetch(
					async (_url, init = {}) => {
						assert.equal(init.signal instanceof AbortSignal, true);
						return new Response("ok");
					},
					async () => {
						const resp = await mod.httpFetch(
							"https://example.test/native-any",
							{
								socket: false,
								timeoutMs: 1000,
								signal: ac.signal,
							},
						);
						assert.equal(await resp.text(), "ok");
					},
				);
				assert.equal(calls, 1);
				assert.equal(seenSignals[0], ac.signal);
				assert.equal(seenSignals.length, 2);
				assert.equal(seenSignals[1] instanceof AbortSignal, true);
			} finally {
				Object.defineProperty(AbortSignal, "any", {
					configurable: true,
					value: originalAny,
				});
			}
		},
	],
	[
		"summarizes upstream errors and fallback eligibility",
		async () => {
			const err = new Error("bad gateway");
			err.code = "upstream_bad_gateway";
			err.status = 502;
			err.upstreamStatus = 503;
			assert.equal(mod.upstreamErrorMessage(err), "bad gateway");
			assert.equal(mod.upstreamErrorCode(err), "upstream_bad_gateway");
			assert.equal(mod.upstreamErrorStatus(err), 502);
			assert.equal(mod.upstreamErrorStatus({ status: 399 }), undefined);
			assert.match(mod.errorLogSummary(err), /type=Error/);
			assert.match(mod.errorLogSummary(err), /code=upstream_bad_gateway/);
			assert.match(mod.errorLogSummary(err), /status=502/);
			assert.match(mod.errorLogSummary(err), /upstreamStatus=503/);
			err.upstreamStatus = 200;
			err.rawLength = 37;
			assert.match(mod.errorLogSummary(err), /upstreamStatus=200/);
			assert.match(mod.errorLogSummary(err), /rawLength=37/);
			assert.match(mod.errorLogSummary("plain failure"), /type=string/);
			assert.equal(
				mod.canFallbackAfterSocketError("POST", new Error("socket closed")),
				true,
			);
			assert.equal(
				mod.canFallbackAfterSocketError("POST", { upstreamStatus: 502 }),
				false,
			);

			const reason = new Error("custom reason");
			const ac = new AbortController();
			ac.abort(reason);
			assert.equal(mod.abortError(ac.signal), reason);
			const plainAbort = mod.abortError();
			assert.equal(plainAbort.name, "AbortError");
			assert.equal(plainAbort.code, "request_aborted");
			assert.match(plainAbort.message, /request aborted/);
		},
	],
	[
		"generates runtime ids through native crypto paths",
		async () => {
			await withPatchedGlobal(
				"crypto",
				{
					getRandomValues(arr) {
						for (let i = 0; i < arr.length; i++) arr[i] = 0xab + i;
						return arr;
					},
					randomUUID() {
						return "native-uuid";
					},
				},
				async () => {
					assert.deepEqual(Array.from(mod.randomBytes(3)), [0xab, 0xac, 0xad]);
					await withoutTypedArrayHexMethod(async () => {
						assert.equal(mod.randHex(5), "abaca");
					});
					assert.equal(mod.uuid(), "native-uuid");
				},
			);
		},
	],
	[
		"builds and caches SAPISIDHASH authorization headers",
		async () => {
			const originalNow = Date.now;
			Date.now = () => 1_700_000_000_000;
			let digestCalls = 0;
			let digestInput = "";
			try {
				await withPatchedGlobal(
					"crypto",
					{
						subtle: {
							async digest(algorithm, data) {
								digestCalls++;
								assert.equal(algorithm, "SHA-1");
								digestInput = new TextDecoder().decode(data);
								const bytes = new Uint8Array(20);
								bytes[0] = 0xab;
								bytes[19] = 0xcd;
								return bytes.buffer;
							},
						},
					},
					async () => {
						const first = await mod.makeSapisidHash("sapi-cache-test");
						const second = await mod.makeSapisidHash("sapi-cache-test");
						assert.equal(
							first,
							"SAPISIDHASH 1700000000_ab000000000000000000000000000000000000cd",
						);
						assert.equal(second, first);
						assert.equal(digestCalls, 1);
						assert.equal(
							digestInput,
							"1700000000 sapi-cache-test https://gemini.google.com",
						);
						assert.equal(mod._sapisidHashCache.value, first);
					},
				);
			} finally {
				Date.now = originalNow;
			}
		},
	],
	[
		"marks prompt conversion as over byte budget",
		async () => {
			const result = mod.messagesToPrompt(
				[{ role: "user", content: "x".repeat(40) }],
				null,
				null,
				[],
				"",
				10,
			);
			assert.equal(result.byteCheck.exceeded, true);
			assert.equal(result.byteCheck.exact, false);
			assert.equal(result.byteCheck.bytes > 10, true);
		},
	],
	[
		"parses LOG_REQUESTS boolean config",
		async () => {
			assert.equal(mod.getConfig({}).log_requests, false);
			assert.equal(mod.getConfig({}).request_body_max_bytes, 16 * 1024 * 1024);
			assert.equal(
				mod.getConfig({ LOG_REQUESTS: "false" }).log_requests,
				false,
			);
			assert.equal(mod.getConfig({ LOG_REQUESTS: "true" }).log_requests, true);
		},
	],
	[
		"recomputes config when a reused env object changes",
		async () => {
			const env = {
				LOG_REQUESTS: "false",
				GENERIC_FILE_UPLOAD_MAX_BYTES: "123",
			};
			assert.equal(mod.getConfig(env).log_requests, false);
			assert.equal(mod.getConfig(env).generic_file_upload_max_bytes, 123);
			env.LOG_REQUESTS = "true";
			env.GENERIC_FILE_UPLOAD_MAX_BYTES = "456";
			assert.equal(mod.getConfig(env).log_requests, true);
			assert.equal(mod.getConfig(env).generic_file_upload_max_bytes, 456);
		},
	],
	[
		"reuses config cache entries after switching env objects",
		async () => {
			const envA = { LOG_REQUESTS: "true" };
			const envB = { LOG_REQUESTS: "false" };
			const cfgA = mod.getConfig(envA);
			const cfgB = mod.getConfig(envB);
			assert.equal(cfgA === cfgB, false);
			assert.equal(mod.getConfig(envA), cfgA);
		},
	],
	[
		"recomputes config after mutating array-form API keys in place",
		async () => {
			const env = { API_KEYS: ["sk-one", "sk-two"] };
			const first = mod.getConfig(env);
			assert.deepEqual(first.api_keys, ["sk-one", "sk-two"]);
			env.API_KEYS[1] = "sk-three";
			const changed = mod.getConfig(env);
			assert.equal(changed === first, false);
			assert.deepEqual(changed.api_keys, ["sk-one", "sk-three"]);
			env.API_KEYS.push("sk-four");
			assert.deepEqual(mod.getConfig(env).api_keys, [
				"sk-one",
				"sk-three",
				"sk-four",
			]);
		},
	],
	[
		"parses strict comma-separated and JSON-array API key config",
		async () => {
			assert.deepEqual(mod.getConfig({}).api_keys, []);
			assert.deepEqual(mod.getConfig({ API_KEYS: "sk-one, sk-two" }).api_keys, [
				"sk-one",
				"sk-two",
			]);
			assert.deepEqual(
				mod.getConfig({ API_KEYS: ["sk-array", "sk-two"] }).api_keys,
				["sk-array", "sk-two"],
			);
			assert.deepEqual(
				mod.getConfig({ API_KEYS: '["sk-json", "sk-two"]' }).api_keys,
				["sk-json", "sk-two"],
			);
			assert.throws(
				() => mod.getConfig({ API_KEYS: '["sk-json", null]' }),
				/API_KEYS must contain only strings/,
			);
			assert.throws(
				() => mod.getConfig({ API_KEYS: '["sk-json", ""]' }),
				/API_KEYS must not contain empty entries/,
			);
			assert.throws(
				() => mod.getConfig({ API_KEYS: '["sk-json", "sk-json"]' }),
				/API_KEYS must not contain duplicate entries/,
			);
			assert.throws(
				() => mod.getConfig({ API_KEYS: "sk-one,,sk-two" }),
				/API_KEYS must not contain empty entries/,
			);
			assert.throws(
				() => mod.getConfig({ API_KEYS: "sk-one,sk-one" }),
				/API_KEYS must not contain duplicate entries/,
			);
		},
	],
	[
		"parses ADMIN_KEY as an ordinary string setting",
		async () => {
			assert.equal(
				mod.getConfig({ ADMIN_KEY: " admin-secret " }).admin_key,
				" admin-secret ",
			);
			assert.equal(
				mod.getConfig({ ADMIN_KEY: "password" }).admin_key,
				"password",
			);
			const longKey = "a".repeat(4097);
			assert.equal(mod.getConfig({ ADMIN_KEY: longKey }).admin_key, longKey);
			assert.throws(
				() => mod.getConfig({ ADMIN_KEY: ["first", "second"] }),
				/ADMIN_KEY must be a string/,
			);
			const env = { ADMIN_KEY: "first" };
			const first = mod.getConfig(env);
			env.ADMIN_KEY = "second";
			const second = mod.getConfig(env);
			assert.equal(second.admin_key, "second");
			assert.equal(first === second, false);
			assert.equal(mod.getConfig({ ADMIN_KEY: "" }).admin_key, "");
		},
	],
	[
		"keeps cached static config separate from request and account context",
		async () => {
			const staticConfig = mod.getConfig({
				GEMINI_COOKIE:
					"__Secure-1PSID=psid; SAPISID=sapi-from-cookie; __Secure-1PSIDTS=ts",
				SAPISID: "",
			});
			assert.equal(Object.hasOwn(staticConfig, "cookie"), false);
			assert.equal(Object.hasOwn(staticConfig, "execution_ctx"), false);
			const executionContext = { waitUntil() {} };
			const runtimeConfig = mod.createRuntimeConfig(
				staticConfig,
				{
					execution_ctx: executionContext,
					supports_authenticated_session: true,
				},
				{
					cookie: "__Secure-1PSID=selected",
					sapisid: "selected-sapisid",
				},
			);
			assert.equal(runtimeConfig === staticConfig, false);
			assert.equal(runtimeConfig.cookie, "__Secure-1PSID=selected");
			assert.equal(runtimeConfig.sapisid, "selected-sapisid");
			assert.equal(runtimeConfig.execution_ctx, executionContext);
			assert.equal(runtimeConfig.supports_authenticated_session, true);
			assert.equal(Object.hasOwn(staticConfig, "cookie"), false);
			const emptySession = mod.createRuntimeConfig(staticConfig);
			assert.equal(emptySession.cookie, "");
			assert.equal(emptySession.sapisid, "");
			assert.equal(Object.isFrozen(staticConfig), true);
			assert.equal(Object.isFrozen(staticConfig.api_keys), true);
			assert.equal(staticConfig.admin_key, "");
		},
	],
	[
		"rejects malformed and out-of-range runtime config",
		async () => {
			for (const env of [
				{ GEMINI_BL: 1 },
				{ DEFAULT_MODEL: "x".repeat(257) },
				{ GEMINI_ORIGIN: "not a URL" },
				{ LOG_REQUESTS: "yes" },
				{ RETRY_ATTEMPTS: "0" },
				{ RETRY_DELAY_SEC: "-1" },
				{ REQUEST_TIMEOUT_SEC: "3601" },
				{ REQUEST_BODY_MAX_BYTES: "0" },
				{ REQUEST_BODY_MAX_BYTES: "104857601" },
				{ CURRENT_INPUT_FILE_MIN_BYTES: "01" },
				{ GENERIC_FILE_UPLOAD_MAX_BYTES: "104857601" },
				{ CURRENT_INPUT_FILE_NAME: "../message.txt" },
				{ GEMINI_ORIGIN: "https://user:secret@example.test/path" },
				{ API_KEYS: 123 },
				{ API_KEYS: [null] },
			]) {
				assert.throws(
					() => mod.getConfig(env),
					/invalid runtime configuration/,
				);
			}
			const cfg = mod.getConfig({
				RETRY_ATTEMPTS: "10",
				RETRY_DELAY_SEC: "0",
				REQUEST_TIMEOUT_SEC: "3600",
				REQUEST_BODY_MAX_BYTES: "104857600",
				CURRENT_INPUT_FILE_MIN_BYTES: "0",
				GENERIC_FILE_UPLOAD_MAX_BYTES: "104857600",
			});
			assert.equal(cfg.retry_attempts, 10);
			assert.equal(cfg.retry_delay_sec, 0);
			assert.equal(cfg.request_timeout_sec, 3600);
			assert.equal(cfg.request_body_max_bytes, 104857600);
			assert.equal(cfg.current_input_file_min_bytes, 0);
			assert.equal(cfg.generic_file_upload_max_bytes, 104857600);
			assert.equal(
				mod.assertRuntimeConfig({ LOG_REQUESTS: "true" }),
				undefined,
			);
		},
	],
	[
		"returns sanitized Worker errors for invalid runtime config",
		async () => {
			const secret = "runtime-config-secret";
			const response = await mod.default.fetch(
				new Request("https://worker.example/v1/models"),
				{ GEMINI_ORIGIN: `https://user:${secret}@example.test/path` },
				{},
			);
			assert.equal(response.status, 500);
			const body = await response.json();
			assert.equal(body.error.code, "invalid_runtime_config");
			assert.equal(body.error.setting, "GEMINI_ORIGIN");
			assert.match(body.error.reason, /absolute HTTP\(S\) origin/);
			assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
		},
	],
	[
		"resolves model defaults think overrides and invalid model inputs",
		async () => {
			assert.equal(
				mod.resolveModel(undefined, "gemini-3.5-flash").name,
				"gemini-3.5-flash",
			);
			const enhanced = mod.resolveModel(
				"gemini-3.1-pro-enhanced@think=4",
				"gemini-3.5-flash",
			);
			assert.equal(enhanced.name, "gemini-3.1-pro-enhanced");
			assert.equal(enhanced.thinkMode, 4);
			assert.deepEqual(enhanced.extra, { 31: 2, 80: 3 });
			assert.match(
				mod.resolveModel("gemini-3.5-flash@think=fast", "gemini-3.5-flash")
					.error,
				/Invalid think level/,
			);
			assert.match(
				mod.resolveModel("gemini-3.5-flash@think=9", "gemini-3.5-flash").error,
				/supported values are 0\.\.4/,
			);
			assert.match(
				mod.resolveModel("", "gemini-3.5-flash").error,
				/model \(empty\) is not available/,
			);
			assert.match(
				mod.resolveModel("not-a-model", "gemini-3.5-flash").error,
				/not-a-model/,
			);
		},
	],
	[
		"serves OpenAI model list route",
		async () => {
			const resp = await mod.default.fetch(
				new Request("https://worker.example/v1/models"),
				{},
				{},
			);
			assert.equal(resp.status, 200);
		},
	],
	[
		"keeps application route policy ordering explicit",
		async () => {
			const execution = { waitUntil() {} };
			const routeCases = [
				{
					method: "OPTIONS",
					path: "/v1/models",
					env: { LOG_REQUESTS: "false" },
					status: 204,
				},
				{
					method: "GET",
					path: "/",
					env: { API_KEYS: "required" },
					status: 200,
				},
				{
					method: "GET",
					path: "/v1/models",
					env: { API_KEYS: "required" },
					status: 401,
				},
				{
					method: "GET",
					path: "/admin",
					env: { API_KEYS: "required" },
					status: 200,
				},
				{
					method: "GET",
					path: "/missing",
					env: {},
					status: 404,
				},
				{
					method: "POST",
					path: "/missing",
					env: {},
					status: 404,
				},
			];
			for (const item of routeCases) {
				const response = await mod.handleApplicationRequest(
					new Request(`https://worker.example${item.path}`, {
						method: item.method,
					}),
					item.env,
					execution,
				);
				assert.equal(
					response.status,
					item.status,
					`${item.method} ${item.path}`,
				);
			}
		},
	],
	[
		"keeps the Worker entrypoint aligned with the application core",
		async () => {
			const request = () => new Request("https://worker.example/v1/models");
			const execution = { waitUntil() {} };
			const direct = await mod.handleApplicationRequest(
				request(),
				{},
				execution,
			);
			const worker = await mod.default.fetch(request(), {}, execution);
			assert.equal(worker.status, direct.status);
			assert.equal(
				worker.headers.get("content-type"),
				direct.headers.get("content-type"),
			);
			assert.equal(await worker.text(), await direct.text());
		},
	],
	[
		"serves health and OpenAI model detail routes",
		async () => {
			const health = await mod.default.fetch(
				new Request("https://worker.example/"),
				{
					API_KEYS: "sk-test",
				},
				{},
			);
			assert.equal(health.status, 200);
			const healthBody = await health.json();
			assert.equal(healthBody.status, "ok");
			assert.equal(Array.isArray(healthBody.models), true);

			const model = await mod.default.fetch(
				new Request("https://worker.example/v1/models/gemini-3.5-flash"),
				{},
				{},
			);
			assert.equal(model.status, 200);
			const modelBody = await model.json();
			assert.equal(modelBody.id, "gemini-3.5-flash");
			assert.equal(modelBody.object, "model");
		},
	],
	[
		"does not initialize or read D1 for health and model-list routes",
		async () => {
			let prepareCalls = 0;
			const env = {
				API_KEYS: "sk-test",
				GEMINI_DB: {
					prepare() {
						prepareCalls++;
						throw new Error("model and health routes must not touch D1");
					},
				},
			};
			const health = await mod.default.fetch(
				new Request("https://worker.example/"),
				env,
				{},
			);
			assert.equal(health.status, 200);
			const openaiModels = await mod.default.fetch(
				new Request("https://worker.example/v1/models", {
					headers: { Authorization: "Bearer sk-test" },
				}),
				env,
				{},
			);
			assert.equal(openaiModels.status, 200);
			const googleModels = await mod.default.fetch(
				new Request("https://worker.example/v1beta/models", {
					headers: { Authorization: "Bearer sk-test" },
				}),
				env,
				{},
			);
			assert.equal(googleModels.status, 200);
			assert.equal(prepareCalls, 0);
		},
	],
	[
		"serves Google model routes and rejects prefix lookalikes",
		async () => {
			const listResp = await mod.default.fetch(
				new Request("https://worker.example/v1beta/models"),
				{},
				{},
			);
			assert.equal(listResp.status, 200);
			const listBody = await listResp.json();
			assert.equal(Array.isArray(listBody.models), true);
			const modelPathResp = await mod.default.fetch(
				new Request("https://worker.example/v1beta/models/gemini-3.5-flash"),
				{},
				{},
			);
			assert.equal(modelPathResp.status, 200);
			const modelPathBody = await modelPathResp.json();
			assert.equal(modelPathBody.name, "models/gemini-3.5-flash");
			assert.equal(modelPathBody.displayName, "gemini-3.5-flash");
			assert.deepEqual(modelPathBody.supportedGenerationMethods, [
				"generateContent",
				"streamGenerateContent",
			]);
			assert.equal(modelPathBody.models, undefined);
			const missingModelResp = await mod.default.fetch(
				new Request("https://worker.example/v1beta/models/not-a-model"),
				{},
				{},
			);
			assert.equal(missingModelResp.status, 404);
			const missingModelBody = await missingModelResp.json();
			assert.equal(missingModelBody.error.code, "model_not_found");
			const invalidPrefixResp = await mod.default.fetch(
				new Request("https://worker.example/v1beta/modelsXYZ"),
				{},
				{},
			);
			assert.equal(invalidPrefixResp.status, 404);
		},
	],
	[
		"handles CORS preflight requested headers and private network opt-in",
		async () => {
			const defaultResp = await mod.default.fetch(
				new Request("https://worker.example/"),
				{},
				{},
			);
			const defaultAllowHeaders =
				defaultResp.headers.get("Access-Control-Allow-Headers") || "";
			assert.match(defaultAllowHeaders, /Content-Type/);
			assert.match(defaultAllowHeaders, /X-API-Key/);
			const resp = await mod.default.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "OPTIONS",
					headers: {
						Origin: "https://app.example",
						"Access-Control-Request-Headers":
							"X-Custom, x-ds2-internal-token, Bad Header, X-Custom",
						"Access-Control-Request-Private-Network": "true",
					},
				}),
				{},
				{},
			);
			assert.equal(resp.status, 204);
			assert.equal(
				resp.headers.get("Access-Control-Allow-Origin"),
				"https://app.example",
			);
			assert.equal(
				resp.headers.get("Access-Control-Allow-Private-Network"),
				"true",
			);
			const allowHeaders =
				resp.headers.get("Access-Control-Allow-Headers") || "";
			assert.match(allowHeaders, /X-Custom/);
			assert.doesNotMatch(allowHeaders, /x-ds2-internal-token/i);
			assert.doesNotMatch(allowHeaders, /Bad Header/);
			assert.equal((allowHeaders.match(/X-Custom/g) || []).length, 1);
		},
	],
	[
		"accepts alternate API key locations and rejects missing keys",
		async () => {
			const env = { API_KEYS: '["sk-test", "sk-secondary"]' };
			const missing = await mod.default.fetch(
				new Request("https://worker.example/v1/models"),
				env,
				{},
			);
			assert.equal(missing.status, 401);
			const bearer = await mod.default.fetch(
				new Request("https://worker.example/v1/models", {
					headers: { Authorization: "  Bearer sk-test  " },
				}),
				env,
				{},
			);
			assert.equal(bearer.status, 200);
			const apiKey = await mod.default.fetch(
				new Request("https://worker.example/v1/models", {
					headers: { "X-API-Key": "sk-test" },
				}),
				env,
				{},
			);
			assert.equal(apiKey.status, 200);
			const googleKey = await mod.default.fetch(
				new Request("https://worker.example/v1beta/models", {
					headers: { "X-Goog-Api-Key": "sk-test" },
				}),
				env,
				{},
			);
			assert.equal(googleKey.status, 200);
			const queryKey = await mod.default.fetch(
				new Request("https://worker.example/v1/models?key=sk-test"),
				env,
				{},
			);
			assert.equal(queryKey.status, 200);
			const paddedQueryKey = await mod.default.fetch(
				new Request("https://worker.example/v1/models?key=%20sk-test%20"),
				env,
				{},
			);
			assert.equal(paddedQueryKey.status, 200);
			const nearMissQueryKey = await mod.default.fetch(
				new Request("https://worker.example/v1/models?key=%20sk-test-extra%20"),
				env,
				{},
			);
			assert.equal(nearMissQueryKey.status, 401);
		},
	],
	[
		"maps malformed route JSON to OpenAI and Google error envelopes",
		async () => {
			const openai = await mod.default.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					body: "[]",
				}),
				{},
				{},
			);
			assert.equal(openai.status, 400);
			const openaiBody = await openai.json();
			assert.equal(
				openaiBody.error.message,
				"request body must be a JSON object",
			);
			assert.equal(openaiBody.error.type, "invalid_request_error");

			const google = await mod.default.fetch(
				new Request(
					"https://worker.example/v1beta/models/gemini-3.5-flash:generateContent",
					{
						method: "POST",
						body: "{",
					},
				),
				{},
				{},
			);
			assert.equal(google.status, 400);
			const googleBody = await google.json();
			assert.equal(googleBody.error.message, "invalid JSON");

			const googleV1 = await mod.default.fetch(
				new Request(
					"https://worker.example/v1/models/gemini-3.5-flash:generateContent",
					{
						method: "POST",
						body: "[]",
					},
				),
				{},
				{},
			);
			assert.equal(googleV1.status, 400);
			const googleV1Body = await googleV1.json();
			assert.equal(
				googleV1Body.error.message,
				"request body must be a JSON object",
			);
		},
	],
	[
		"does not read D1 accounts before public auth or JSON validation succeeds",
		async () => {
			let prepareCalls = 0;
			const env = {
				API_KEYS: "sk-test",
				GEMINI_DB: {
					prepare() {
						prepareCalls += 1;
						throw new Error("D1 should not be read before auth and validation");
					},
				},
			};

			const unauthorized = await mod.default.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: "gemini-3.5-flash",
						messages: [{ role: "user", content: "hello" }],
					}),
				}),
				env,
				{},
			);
			assert.equal(unauthorized.status, 401);
			assert.equal(prepareCalls, 0);

			const invalidJson = await mod.default.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer sk-test",
					},
					body: "[]",
				}),
				env,
				{},
			);
			assert.equal(invalidJson.status, 400);
			assert.equal(
				(await invalidJson.json()).error.message,
				"request body must be a JSON object",
			);
			assert.equal(prepareCalls, 0);
		},
	],
	[
		"uses anonymous upstream for eligible public generation without D1",
		async () => {
			let fetchCalls = 0;
			const run = () =>
				mod.default.fetch(
					new Request("https://worker.example/v1/chat/completions", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							model: "gemini-3.5-flash",
							messages: [{ role: "user", content: "hello" }],
						}),
					}),
					{
						API_KEYS: "",
						LOG_REQUESTS: "false",
					},
					{},
				);
			const resp = await withFetch(async () => {
				fetchCalls += 1;
				return geminiTextResponse("anonymous answer");
			}, run);
			assert.equal(resp.status, 200);
			const body = await resp.json();
			assert.equal(body.choices[0].message.content, "anonymous answer");
			assert.equal(fetchCalls, 1);
		},
	],
	[
		"shares anonymous routing with Google and keeps Pro account-required",
		async () => {
			let fetchCalls = 0;
			const google = await withFetch(
				async () => {
					fetchCalls += 1;
					return geminiTextResponse("google anonymous");
				},
				() =>
					mod.default.fetch(
						new Request(
							"https://worker.example/v1beta/models/gemini-3.5-flash:generateContent",
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									contents: [{ parts: [{ text: "hello" }] }],
								}),
							},
						),
						{},
						{},
					),
			);
			assert.equal(google.status, 200);
			assert.equal(
				(await google.json()).candidates[0].content.parts[0].text,
				"google anonymous",
			);
			assert.equal(fetchCalls, 1);

			const pro = await withFetch(
				async () => {
					fetchCalls += 1;
					throw new Error("Pro must not call anonymous upstream");
				},
				() =>
					mod.default.fetch(
						new Request("https://worker.example/v1/chat/completions", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								model: "gemini-3.1-pro",
								messages: [{ role: "user", content: "hello" }],
							}),
						}),
						{},
						{},
					),
			);
			assert.equal(pro.status, 422);
			const proBody = await pro.json();
			assert.equal(proBody.error.code, "gemini_authenticated_session_required");
			assert.equal(proBody.error.reason, "pro_model");
			assert.equal(fetchCalls, 1);
		},
	],
	[
		"returns authenticated-session errors for oversized context without D1",
		async () => {
			const resp = await mod.default.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: "gemini-3.5-flash",
						messages: [{ role: "user", content: "x".repeat(40) }],
					}),
				}),
				{
					CURRENT_INPUT_FILE_ENABLED: "true",
					CURRENT_INPUT_FILE_MIN_BYTES: "10",
				},
				{},
			);
			assert.equal(resp.status, 422);
			const body = await resp.json();
			assert.equal(body.error.code, "gemini_authenticated_session_required");
			assert.equal(body.error.reason, "large_context");

			const google = await mod.default.fetch(
				new Request(
					"https://worker.example/v1beta/models/gemini-3.5-flash:generateContent",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							contents: [{ parts: [{ text: "x".repeat(40) }] }],
						}),
					},
				),
				{
					CURRENT_INPUT_FILE_ENABLED: "true",
					CURRENT_INPUT_FILE_MIN_BYTES: "10",
				},
				{},
			);
			assert.equal(google.status, 422);
			const googleBody = await google.json();
			assert.equal(
				googleBody.error.code,
				"gemini_authenticated_session_required",
			);
			assert.equal(googleBody.error.reason, "large_context");

			const image = await mod.default.fetch(
				new Request("https://worker.example/v1/images/generations", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ prompt: "draw a square" }),
				}),
				{},
				{},
			);
			assert.equal(image.status, 422);
			const imageBody = await image.json();
			assert.equal(
				imageBody.error.code,
				"gemini_authenticated_session_required",
			);
			assert.equal(imageBody.error.reason, "image");

			const attachment = await mod.default.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: "gemini-3.5-flash",
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: "describe this image" },
									{
										type: "image_url",
										image_url: {
											url: "data:image/png;base64,iVBORw0KGgo=",
										},
									},
								],
							},
						],
					}),
				}),
				{},
				{},
			);
			assert.equal(attachment.status, 422);
			const attachmentBody = await attachment.json();
			assert.equal(
				attachmentBody.error.code,
				"gemini_authenticated_session_required",
			);
			assert.equal(attachmentBody.error.reason, "attachment");
		},
	],
	[
		"covers additional worker routing error envelopes",
		async () => {
			const googleStream = await mod.default.fetch(
				new Request(
					"https://worker.example/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
					{
						method: "POST",
						body: "[]",
					},
				),
				{},
				{},
			);
			assert.equal(googleStream.status, 400);
			const googleStreamBody = await googleStream.json();
			assert.equal(
				googleStreamBody.error.message,
				"request body must be a JSON object",
			);

			const methodFallback = await mod.default.fetch(
				new Request("https://worker.example/v1/models", {
					method: "PATCH",
				}),
				{},
				{},
			);
			assert.equal(methodFallback.status, 404);
			assert.deepEqual(await methodFallback.json(), { error: "not found" });

			const postNotFound = await mod.default.fetch(
				new Request("https://worker.example/v1/unknown", {
					method: "POST",
					body: "{}",
				}),
				{},
				{},
			);
			assert.equal(postNotFound.status, 404);
			assert.deepEqual(await postNotFound.json(), { error: "not found" });

			const logs = [];
			const caught = await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.default.fetch(
						new Request("https://worker.example/v1/models/%E0%A4%A", {
							headers: { Origin: "https://app.example" },
						}),
						{ LOG_REQUESTS: "true" },
						{},
					),
			);
			assert.equal(caught.status, 500);
			assert.equal(
				caught.headers.get("Access-Control-Allow-Origin"),
				"https://app.example",
			);
			const caughtBody = await caught.json();
			assert.deepEqual(caughtBody.error, {
				message: "internal server error",
				code: "internal_server_error",
			});
			assert.equal(logs.length, 2);
			assert.match(logs[0], /^\[web2gem\] error: type=URIError$/);
			assert.doesNotMatch(logs[0], /URI malformed|at /);
			assert.match(
				logs[1],
				/^\[web2gem\] stage=request_complete requestId=.+ method=GET path=\/v1\/models\/%E0%A4%A status=500 ms=/,
			);

			const emptyChat = await mod.default.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model: "gemini-3.5-flash", messages: [] }),
				}),
				{},
				{},
			);
			assert.equal(emptyChat.status, 400);
			assert.equal((await emptyChat.json()).error.message, "empty prompt");

			const contextAvailableBody = JSON.stringify({
				model: "gemini-3.5-flash",
				messages: [],
			});
			const contextAvailable = await mod.default.fetch(
				new Request("https://worker.example/v1/chat/completions", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": String(contextAvailableBody.length),
					},
					body: contextAvailableBody,
				}),
				{
					CURRENT_INPUT_FILE_ENABLED: "true",
					CURRENT_INPUT_FILE_MIN_BYTES: "1",
				},
				{},
			);
			assert.equal(contextAvailable.status, 400);
			assert.equal(
				(await contextAvailable.json()).error.message,
				"empty prompt",
			);
		},
	],
	[
		"rejects oversized inline OpenAI bodies from content length before parsing",
		async () => {
			const resp = await mod.default.fetch(
				new Request("https://worker.example/v1/responses", {
					method: "POST",
					headers: {
						"Content-Length": "2",
					},
					body: "{}",
				}),
				{
					CURRENT_INPUT_FILE_ENABLED: "false",
					CURRENT_INPUT_FILE_MIN_BYTES: "1",
					GENERIC_FILE_UPLOAD_MAX_BYTES: "0",
				},
				{},
			);
			assert.equal(resp.status, 422);
			const body = await resp.json();
			assert.equal(body.error.code, "gemini_authenticated_session_required");
			assert.equal(body.error.reason, "large_context");
			assert.match(body.error.message, /authenticated Gemini session/);
		},
	],
	[
		"joins byte chunks and reads socket byte queues",
		async () => {
			const enc = new TextEncoder();
			const dec = new TextDecoder();
			assert.equal(
				dec.decode(
					mod._joinByteChunks([enc.encode("ab"), enc.encode("cd")], 4),
				),
				"abcd",
			);
			assert.equal(dec.decode(mod.bytesFromBody("hello")), "hello");
			assert.equal(
				dec.decode(mod.bytesFromBody(enc.encode("view").buffer)),
				"view",
			);
			assert.equal(mod.parseHttpChunkSizeLine(enc.encode(" a;ext=1 ")), 10);
			assert.equal(mod.parseHttpChunkSizeLine(enc.encode("0;done")), 0);
			assert.equal(mod.parseHttpChunkSizeLine(enc.encode("a ;ext=1")), -1);
			assert.equal(mod.parseHttpChunkSizeLine(enc.encode("Z")), -1);

			const queue = mod.createByteQueue(enc.encode("one\r\n"));
			queue.push(enc.encode("two\r\ntail"));
			assert.equal(dec.decode(queue.readLine()), "one");
			assert.equal(dec.decode(queue.readLineIfAvailable()), "two");
			assert.equal(dec.decode(queue.read(4)), "tail");
			assert.equal(queue.length, 0);

			const splitQueue = mod.createByteQueue(enc.encode("ab"));
			splitQueue.push(enc.encode("cd\r"));
			assert.equal(splitQueue.readLineIfAvailable(), null);
			splitQueue.push(enc.encode("\nrest"));
			assert.equal(dec.decode(splitQueue.readLineIfAvailable()), "abcd");
			assert.equal(dec.decode(splitQueue.read(4)), "rest");

			const chunkSizeQueue = mod.createByteQueue(enc.encode(" a;"));
			chunkSizeQueue.push(enc.encode("ext=1\r\nbody"));
			assert.deepEqual(chunkSizeQueue.readHttpChunkSizeLineIfAvailable(), {
				size: 10,
				errorLine: "a",
			});
			assert.equal(dec.decode(chunkSizeQueue.read(4)), "body");

			const byteSplitChunkSize = mod.createByteQueue();
			for (const byte of enc.encode(`1;${"x".repeat(4096)}\r\nbody`)) {
				byteSplitChunkSize.push(new Uint8Array([byte]));
			}
			assert.deepEqual(byteSplitChunkSize.readHttpChunkSizeLineIfAvailable(), {
				size: 1,
				errorLine: "1",
			});
			assert.equal(dec.decode(byteSplitChunkSize.read(4)), "body");

			const invalidChunkSize = mod.createByteQueue(enc.encode("a "));
			invalidChunkSize.push(enc.encode(";ext=1\r\n"));
			assert.deepEqual(invalidChunkSize.readHttpChunkSizeLineIfAvailable(), {
				size: -1,
				errorLine: "a",
			});
		},
	],
	[
		"validates structured output const enum and uniqueness",
		async () => {
			assert.equal(
				mod.jsonValuesEqual(
					{ a: 1, b: [2, { c: true }] },
					{ b: [2, { c: true }], a: 1 },
				),
				true,
			);
			assert.equal(mod.jsonValuesEqual({ a: 1 }, { a: 1, b: 2 }), false);
			assert.equal(
				mod.validateStructuredOutputValue([1, "1", true, false, null], {
					type: "json_schema",
					schema: { type: "array", uniqueItems: true },
				}),
				"",
			);
			assert.equal(
				mod.validateStructuredOutputValue(["x", "x"], {
					type: "json_schema",
					schema: { type: "array", uniqueItems: true },
				}),
				"$ must contain unique items",
			);
			assert.equal(
				mod.validateStructuredOutputValue(
					{ b: 2, a: 1 },
					{ type: "json_schema", schema: { const: { a: 1, b: 2 } } },
				),
				"",
			);
			assert.equal(
				mod.validateStructuredOutputValue(
					{ b: 2, a: 1 },
					{ type: "json_schema", schema: { enum: [{ a: 1, b: 2 }] } },
				),
				"",
			);
			assert.equal(
				mod.validateStructuredOutputValue(
					[
						{ b: 2, a: 1 },
						{ a: 1, b: 2 },
					],
					{ type: "json_schema", schema: { type: "array", uniqueItems: true } },
				),
				"$ must contain unique items",
			);
		},
	],
	[
		"aborts SSE producer when client cancels",
		async () => {
			let sawAbort = false;
			let resolveDone;
			const done = new Promise((resolve) => {
				resolveDone = resolve;
			});
			const resp = mod.sseResponse(async (write, signal) => {
				write("data: one\n\n");
				await new Promise((resolve) =>
					signal.addEventListener("abort", resolve, { once: true }),
				);
				sawAbort = signal.aborted;
				resolveDone();
			});
			const reader = resp.body.getReader();
			const first = await reader.read();
			assert.equal(first.done, false);
			await reader.cancel();
			await done;
			assert.equal(sawAbort, true);
		},
	],
	[
		"handles SSE writes that race after client cancellation",
		async () => {
			let resolveAfterCancel;
			const afterCancel = new Promise((resolve) => {
				resolveAfterCancel = resolve;
			});
			const resp = mod.sseResponse(async (write, signal) => {
				write("data: one\n\n");
				await new Promise((resolve) => {
					signal.addEventListener(
						"abort",
						() => {
							write("data: after-cancel\n\n");
							resolveAfterCancel(signal.reason);
							resolve();
						},
						{ once: true },
					);
				});
			});
			const reader = resp.body.getReader();
			const first = await reader.read();
			assert.equal(first.done, false);
			await reader.cancel();
			assert.equal(await afterCancel, "client disconnected");
		},
	],
	[
		"emits SSE error frames and custom onError output",
		async () => {
			const errored = mod.sseResponse(() => {
				const err = new Error("stream failed");
				err.code = "upstream_failed";
				throw err;
			});
			const errorText = await errored.text();
			assert.match(errorText, /event: error/);
			assert.match(errorText, /"message":"stream failed"/);
			assert.match(errorText, /"code":"upstream_failed"/);

			const custom = mod.sseResponse(
				() => {
					throw new Error("hidden");
				},
				{
					onError(write, err) {
						write(`event: custom\ndata: ${String(err.message)}\n\n`);
					},
				},
			);
			assert.equal(await custom.text(), "event: custom\ndata: hidden\n\n");
		},
	],
	[
		"aborts SSE producers when stream writes fail",
		async () => {
			const NativeTransformStream = globalThis.TransformStream;

			await withPatchedGlobal(
				"TransformStream",
				class {
					constructor() {
						this.readable = new NativeTransformStream().readable;
						this.writable = {
							getWriter() {
								return {
									closed: new Promise(() => {}),
									write() {
										return Promise.reject(new Error("write rejected"));
									},
									close() {
										return Promise.resolve();
									},
									releaseLock() {},
								};
							},
						};
					}
				},
				async () => {
					let sawAbort = false;
					const done = new Promise((resolve) => {
						mod.sseResponse(async (write, signal) => {
							write("data: rejected\n\n");
							await new Promise((innerResolve) =>
								signal.addEventListener("abort", innerResolve, { once: true }),
							);
							sawAbort = signal.aborted;
							resolve();
						});
					});
					await done;
					assert.equal(sawAbort, true);
				},
			);

			await withPatchedGlobal(
				"TransformStream",
				class {
					constructor() {
						this.readable = new NativeTransformStream().readable;
						this.writable = {
							getWriter() {
								return {
									closed: new Promise(() => {}),
									write() {
										throw new Error("write threw");
									},
									close() {
										return Promise.resolve();
									},
									releaseLock() {},
								};
							},
						};
					}
				},
				async () => {
					let sawAbort = false;
					const done = new Promise((resolve) => {
						mod.sseResponse(async (write, signal) => {
							write("data: thrown\n\n");
							sawAbort = signal.aborted;
							resolve();
						});
					});
					await done;
					assert.equal(sawAbort, true);
				},
			);
		},
	],
	[
		"reads JSON requests and cancels oversized bodies",
		async () => {
			const valid = await mod.readJsonRequest(
				new Request("https://worker.example/", {
					method: "POST",
					body: JSON.stringify({ ok: true }),
				}),
			);
			assert.deepEqual(valid.value, { ok: true });
			assert.equal(valid.bytes > 0, true);

			let nativeBytesCalled = false;
			const nativeBytesRequest = new Request("https://worker.example/", {
				method: "POST",
				body: "{}",
			});
			Object.defineProperty(nativeBytesRequest, "bytes", {
				configurable: true,
				value: async () => {
					nativeBytesCalled = true;
					return new TextEncoder().encode('{"ok":"bytes"}');
				},
			});
			Object.defineProperty(nativeBytesRequest, "arrayBuffer", {
				configurable: true,
				value: async () => {
					throw new Error("arrayBuffer should not be used");
				},
			});
			const nativeBytes = await mod.readJsonRequest(nativeBytesRequest);
			assert.deepEqual(nativeBytes.value, { ok: "bytes" });
			assert.equal(nativeBytesCalled, true);

			const declaredLarge = await mod.readJsonRequest(
				new Request("https://worker.example/", {
					method: "POST",
					headers: { "Content-Length": "1000" },
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array([123, 125]));
							controller.close();
						},
					}),
					duplex: "half",
				}),
				{
					maxBodyBytes: 1000,
				},
			);
			assert.deepEqual(declaredLarge.value, {});

			let declaredSmallCanceled = false;
			let declaredSmallPulls = 0;
			const declaredSmallActualLarge = await mod.readJsonRequest(
				new Request("https://worker.example/", {
					method: "POST",
					headers: { "Content-Length": "1" },
					body: new ReadableStream({
						pull(controller) {
							declaredSmallPulls += 1;
							controller.enqueue(
								new TextEncoder().encode(
									declaredSmallPulls === 1 ? '{"a":"123"' : "}",
								),
							);
						},
						cancel() {
							declaredSmallCanceled = true;
						},
					}),
					duplex: "half",
				}),
				{
					maxBodyBytes: 10,
				},
			);
			assert.equal(declaredSmallActualLarge.status, 413);
			assert.match(declaredSmallActualLarge.error, /11 bytes > 10/);
			assert.equal(declaredSmallPulls, 2);
			assert.equal(declaredSmallCanceled, true);

			let canceled = false;
			const oversized = await mod.readJsonRequest(
				new Request("https://worker.example/", {
					method: "POST",
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"a"'));
							controller.enqueue(new TextEncoder().encode(":1}"));
						},
						cancel() {
							canceled = true;
						},
					}),
					duplex: "half",
				}),
				{
					maxBodyBytes: 3,
					oversizedError: {
						message: "too large for test",
						status: 413,
						code: "too_large",
					},
				},
			);
			assert.equal(oversized.status, 413);
			assert.equal(oversized.code, "too_large");
			assert.equal(canceled, true);

			const failedRead = await mod.readJsonRequest(
				new Request("https://worker.example/", {
					method: "POST",
					body: new ReadableStream({
						pull() {
							throw new Error("stream broke");
						},
					}),
					duplex: "half",
				}),
			);
			assert.equal(failedRead.status, 400);
			assert.match(
				failedRead.error,
				/failed to read request body: stream broke/,
			);

			const invalidUtf8 = await mod.readJsonRequest(
				new Request("https://worker.example/", {
					method: "POST",
					body: new Uint8Array([0xff]),
				}),
			);
			assert.equal(invalidUtf8.error, "invalid UTF-8 request body");

			const invalidUtf8String = await mod.readJsonRequest(
				new Request("https://worker.example/", {
					method: "POST",
					body: concatBytes(
						new TextEncoder().encode('{"x":"'),
						new Uint8Array([0xff]),
						new TextEncoder().encode('"}'),
					),
				}),
			);
			assert.equal(invalidUtf8String.error, "invalid UTF-8 request body");

			const invalidJson = await mod.readJsonRequest(
				new Request("https://worker.example/", {
					method: "POST",
					body: "{",
				}),
			);
			assert.equal(invalidJson.error, "invalid JSON");

			const nonObject = await mod.readJsonRequest(
				new Request("https://worker.example/", {
					method: "POST",
					body: "[]",
				}),
			);
			assert.equal(nonObject.error, "request body must be a JSON object");
		},
	],
	[
		"covers socket byte body helpers and timeout cleanup",
		async () => {
			assert.equal(mod.bytesFromBody(null), null);
			assert.equal(mod.bytesFromBody(3).length, 3);
			assert.deepEqual(
				Array.from(mod.bytesFromBody(new Uint8Array([1, 2, 3]).buffer)),
				[1, 2, 3],
			);
			const bytes = new Uint8Array([4, 5, 6, 7]);
			assert.deepEqual(
				Array.from(mod.bytesFromBody(new DataView(bytes.buffer, 1, 2))),
				[5, 6],
			);

			const timeoutErr = mod.socketTimeoutError("headers", 3);
			assert.equal(timeoutErr.code, "socket_timeout");
			assert.match(timeoutErr.message, /headers timed out after 3ms/);

			let closeCount = 0;
			const socket = {
				close() {
					closeCount += 1;
				},
			};
			await assert.rejects(
				() => mod.withSocketTimeout(new Promise(() => {}), 1, "idle", socket),
				/idle timed out/,
			);
			assert.equal(closeCount, 1);
			mod.closeSocketQuietly({
				close() {
					closeCount += 1;
					throw new Error("close failed");
				},
			});
			mod.closeSocketQuietly({ close: "not a function" });
			assert.equal(closeCount, 2);

			assert.equal(
				await mod.withSocketTimeout(
					Promise.resolve("ok"),
					0,
					"disabled",
					socket,
				),
				"ok",
			);
			const aborted = new AbortController();
			aborted.abort("before start");
			await assert.rejects(
				() =>
					mod.withSocketTimeout(
						Promise.resolve("unused"),
						10,
						"aborted",
						socket,
						aborted.signal,
					),
				/before start/,
			);

			const lateAbort = new AbortController();
			await assert.rejects(
				() =>
					mod.withSocketTimeout(
						Promise.resolve().then(() => {
							lateAbort.abort("after settle");
							return "unused";
						}),
						10,
						"late",
						socket,
						lateAbort.signal,
					),
				/after settle/,
			);

			const rejectAbort = new AbortController();
			await assert.rejects(
				() =>
					mod.withSocketTimeout(
						Promise.resolve().then(() => {
							rejectAbort.abort("reject abort");
							throw new Error("original failure");
						}),
						10,
						"reject",
						socket,
						rejectAbort.signal,
					),
				/reject abort/,
			);
		},
	],
	[
		"sends socket HTTP requests with content length",
		async () => {
			const state = {};
			const resp = await mod.socketHttp(
				fakeSocketConnect(
					["HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"],
					state,
				),
				"https://example.test/path?q=1",
				{
					method: "POST",
					headers: {
						"Accept-Encoding": "gzip",
						Connection: "keep-alive",
						"Content-Length": "999",
						Host: "evil.test",
						"X-Test": "yes",
					},
					body: "body",
				},
			);
			assert.equal(resp.status, 200);
			assert.equal(await resp.text(), "hello");
			assert.match(joinedWriteText(state), /POST \/path\?q=1 HTTP\/1\.1/);
			assert.match(joinedWriteText(state), /Host: example\.test/);
			assert.match(joinedWriteText(state), /Accept-Encoding: identity/);
			assert.match(joinedWriteText(state), /Connection: close/);
			assert.match(joinedWriteText(state), /Content-Length: 4/);
			assert.match(joinedWriteText(state), /X-Test: yes/);
			assert.doesNotMatch(joinedWriteText(state), /evil\.test/);
			assert.doesNotMatch(joinedWriteText(state), /Content-Length: 999/);
		},
	],
	[
		"decodes compressed socket HTTP responses when explicitly enabled",
		async () => {
			const body = await gzipText("hello");
			const state = {};
			const resp = await mod.socketHttp(
				fakeSocketConnect(
					[
						`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${body.length}\r\n\r\n`,
						body,
					],
					state,
				),
				"https://example.test/compressed",
				{ acceptCompressed: true },
			);
			assert.equal(await resp.text(), "hello");
			assert.equal(resp.headers.get("content-encoding"), null);
			assert.equal(resp.headers.get("content-length"), null);
			assert.match(joinedWriteText(state), /Accept-Encoding: gzip\r\n/);
		},
	],
	[
		"reuses socket HTTP keep-alive connections after complete bounded responses",
		async () => {
			const state = {};
			const connect = fakePersistentSocketConnect(
				[
					["HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\none"],
					["HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo"],
				],
				state,
			);
			const pool = mod.createSocketPool();
			try {
				const first = await mod.socketHttp(
					connect,
					"https://example.test/one",
					{ keepAlive: true, pool },
				);
				assert.equal(first.status, 200);
				assert.equal(await first.text(), "one");

				const second = await mod.socketHttp(
					connect,
					"https://example.test/two",
					{ keepAlive: true, pool },
				);
				assert.equal(second.status, 200);
				assert.equal(await second.text(), "two");

				const writes = joinedWriteText(state);
				assert.equal(state.connects, 1);
				assert.match(writes, /GET \/one HTTP\/1\.1/);
				assert.match(writes, /GET \/two HTTP\/1\.1/);
				assert.equal((writes.match(/Connection: keep-alive/g) || []).length, 2);
				assert.equal(state.closed, 0);
			} finally {
				mod.closeIdleSocketPool(pool);
			}
		},
	],
	[
		"does not reuse socket HTTP connections when upstream asks to close",
		async () => {
			const state = {};
			const connect = fakePersistentSocketConnect(
				[
					[
						"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\none",
					],
					["HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo"],
				],
				state,
			);
			const pool = mod.createSocketPool();
			try {
				const first = await mod.socketHttp(
					connect,
					"https://example.test/close-one",
					{ keepAlive: true, pool },
				);
				assert.equal(await first.text(), "one");

				const second = await mod.socketHttp(
					connect,
					"https://example.test/close-two",
					{ keepAlive: true, pool },
				);
				assert.equal(await second.text(), "two");

				assert.equal(state.connects, 2);
				assert.equal(state.closed, 1);
			} finally {
				mod.closeIdleSocketPool(pool);
			}
		},
	],
	[
		"manages socket idle pool expiry cap and explicit close",
		async () => {
			const originalNow = Date.now;
			let now = 1000;
			const sockets = [];
			const makeSocket = (name) => {
				const socket = {
					name,
					closed: 0,
					close() {
						this.closed += 1;
					},
				};
				sockets.push(socket);
				return socket;
			};
			Date.now = () => now;
			try {
				const pool = mod.createSocketPool();
				const key = mod.socketPoolKey(
					new URL("http://example.test:8080/path"),
					false,
					8080,
				);
				assert.equal(key, "http://example.test:8080");

				const first = makeSocket("first");
				const second = makeSocket("second");
				const third = makeSocket("third");
				mod.putIdleSocket(pool, key, first);
				mod.putIdleSocket(pool, key, second);
				mod.putIdleSocket(pool, key, third);
				assert.equal(first.closed, 1);
				assert.equal(
					pool.idle.get(key).length,
					mod.SOCKET_KEEP_ALIVE_MAX_IDLE_PER_ORIGIN,
				);

				assert.equal(mod.takeIdleSocket(pool, key), third);
				now += mod.SOCKET_KEEP_ALIVE_IDLE_MS + 1;
				assert.equal(mod.takeIdleSocket(pool, key), null);
				assert.equal(second.closed, 1);
				assert.equal(pool.idle.has(key), false);

				const fourth = makeSocket("fourth");
				mod.putIdleSocket(pool, key, fourth);
				mod.closeIdleSocketPool(pool);
				assert.equal(fourth.closed, 1);
				assert.equal(pool.idle.size, 0);
				mod.closeIdleSocketPool(null);
			} finally {
				Date.now = originalNow;
			}
			assert.deepEqual(
				sockets.map((socket) => [socket.name, socket.closed]),
				[
					["first", 1],
					["second", 1],
					["third", 0],
					["fourth", 1],
				],
			);
		},
	],
	[
		"enables socket keep-alive on the httpFetch upstream path",
		async () => {
			const state = {};
			const connect = fakePersistentSocketConnect(
				[
					["HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\none"],
					["HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo"],
				],
				state,
			);
			mod._setConnectForTest(connect);
			try {
				const first = await mod.httpFetch("https://example.test/fetch-one", {
					socket: true,
					timeoutMs: 1000,
				});
				assert.equal(await first.text(), "one");

				const second = await mod.httpFetch("https://example.test/fetch-two", {
					socket: true,
					timeoutMs: 1000,
				});
				assert.equal(await second.text(), "two");

				assert.equal(state.connects, 1);
				assert.equal(
					(joinedWriteText(state).match(/Connection: keep-alive/g) || [])
						.length,
					2,
				);
			} finally {
				mod._setConnectForTest(null);
			}
		},
	],
	[
		"decodes chunked socket HTTP responses",
		async () => {
			const resp = await mod.socketHttp(
				fakeSocketConnect([
					"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nhe",
					"ll\r\n1\r\no\r\n0\r\n\r\n",
				]),
				"https://example.test/chunked",
			);
			assert.equal(resp.status, 200);
			assert.equal(await resp.text(), "hello");

			const splitSize = await mod.socketHttp(
				fakeSocketConnect([
					"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
					"5",
					"\r\nhello\r\n0\r\n\r\n",
				]),
				"https://example.test/split-chunk-size",
			);
			assert.equal(await splitSize.text(), "hello");

			const extension = await mod.socketHttp(
				fakeSocketConnect([
					"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;foo=bar\r\nhello\r\n0;done\r\n\r\n",
				]),
				"https://example.test/chunk-extension",
			);
			assert.equal(await extension.text(), "hello");
		},
	],
	[
		"handles socket responses with no body or close-delimited identity bodies",
		async () => {
			const noBody = await mod.socketHttp(
				fakeSocketConnect([
					"HTTP/1.1 204 No Content\r\nContent-Length: 5\r\n\r\nhello",
				]),
				"https://example.test/no-body",
				{ method: "HEAD" },
			);
			assert.equal(noBody.status, 204);
			assert.equal(await noBody.text(), "");

			const identity = await mod.socketHttp(
				fakeSocketConnect(["HTTP/1.1 200 OK\r\nX-Test: yes\r\n\r\nhe", "llo"]),
				"https://example.test/identity",
			);
			assert.equal(identity.status, 200);
			assert.equal(identity.headers.get("x-test"), "yes");
			assert.equal(await identity.text(), "hello");
		},
	],
	[
		"skips interim 100 Continue socket responses",
		async () => {
			const resp = await mod.socketHttp(
				fakeSocketConnect([
					"HTTP/1.1 100 Continue\r\n\r\n",
					"HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok",
				]),
				"https://example.test/continue",
			);
			assert.equal(resp.status, 201);
			assert.equal(await resp.text(), "ok");
		},
	],
	[
		"rejects invalid socket Content-Length headers",
		async () => {
			await assert.rejects(
				() =>
					mod.socketHttp(
						fakeSocketConnect([
							"HTTP/1.1 200 OK\r\nContent-Length: nope\r\n\r\n",
						]),
						"https://example.test/bad-length",
					),
				/invalid Content-Length/,
			);
		},
	],
	[
		"rejects invalid socket chunk sizes and terminators",
		async () => {
			const invalidSize = await mod.socketHttp(
				fakeSocketConnect([
					"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n",
				]),
				"https://example.test/bad-chunk-size",
			);
			await assert.rejects(() => invalidSize.text(), /invalid chunk size/);

			const invalidTerminator = await mod.socketHttp(
				fakeSocketConnect([
					"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\naXX",
				]),
				"https://example.test/bad-chunk-terminator",
			);
			await assert.rejects(
				() => invalidTerminator.text(),
				/invalid chunk terminator/,
			);
		},
	],
	[
		"rejects incomplete socket chunked bodies",
		async () => {
			const resp = await mod.socketHttp(
				fakeSocketConnect([
					"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhe",
				]),
				"https://example.test/incomplete-chunked",
			);
			await assert.rejects(() => resp.text(), /incomplete chunked body/);

			const missingTerminator = await mod.socketHttp(
				fakeSocketConnect([
					"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello",
				]),
				"https://example.test/incomplete-chunk-terminator",
			);
			await assert.rejects(
				() => missingTerminator.text(),
				/incomplete chunked body/,
			);
		},
	],
	[
		"rejects incomplete fixed-length socket bodies",
		async () => {
			const resp = await mod.socketHttp(
				fakeSocketConnect(["HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe"]),
				"https://example.test/incomplete-fixed",
			);
			await assert.rejects(() => resp.text(), /incomplete fixed-length body/);
		},
	],
	[
		"rejects malformed socket response headers before exposing a body",
		async () => {
			await assert.rejects(
				() =>
					mod.socketHttp(
						fakeSocketConnect(["HTTP/1.1 200 OK\r\nContent-Length: 1\r\n"]),
						"https://example.test/incomplete-headers",
					),
				/incomplete HTTP response headers/,
			);

			await assert.rejects(
				() =>
					mod.socketHttp(
						fakeSocketConnect([
							`HTTP/1.1 200 OK\r\nX-Fill: ${"x".repeat(64 * 1024)}\r\n`,
						]),
						"https://example.test/huge-headers",
					),
				/HTTP response headers exceed/,
			);

			await assert.rejects(
				() =>
					mod.socketHttp(
						fakeSocketConnect([
							"HTTP/1.1 200 OK\r\nContent-Length: 999999999999999999999\r\n\r\n",
						]),
						"https://example.test/huge-content-length",
					),
				/invalid Content-Length/,
			);
		},
	],
	[
		"handles socket zero-length bodies trailers and body cancellation cleanup",
		async () => {
			const zero = await mod.socketHttp(
				fakeSocketConnect([
					"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nignored",
				]),
				"https://example.test/zero",
			);
			assert.equal(await zero.text(), "");

			const trailer = await mod.socketHttp(
				fakeSocketConnect([
					"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\nX-Trailer: yes\r\n\r\n",
				]),
				"https://example.test/trailer",
			);
			assert.equal(await trailer.text(), "hello");

			const state = {};
			const identity = await mod.socketHttp(
				fakeSocketConnect(["HTTP/1.1 200 OK\r\n\r\nhello"], state),
				"https://example.test/cancel-body",
			);
			const reader = identity.body.getReader();
			const first = await reader.read();
			assert.equal(new TextDecoder().decode(first.value), "hello");
			await reader.cancel();
			assert.equal(state.closed, true);
		},
	],
	[
		"closes sockets when request writes fail",
		async () => {
			const state = { closed: false };
			const connect = () => ({
				readable: new ReadableStream(),
				writable: new WritableStream({
					write() {
						throw new Error("write boom");
					},
				}),
				close() {
					state.closed = true;
				},
			});
			await assert.rejects(
				() =>
					mod.socketHttp(connect, "https://example.test/write-failure", {
						body: "body",
					}),
				/write boom/,
			);
			assert.equal(state.closed, true);
		},
	],
	[
		"rejects socket stream bodies without length before opening a socket",
		async () => {
			let connected = false;
			await assert.rejects(
				() =>
					mod.socketHttp(
						() => {
							connected = true;
							return {
								readable: new ReadableStream(),
								writable: new WritableStream(),
								close() {},
							};
						},
						"https://example.test/missing-length",
						{
							method: "POST",
							body: new ReadableStream({
								start(controller) {
									controller.enqueue(new TextEncoder().encode("x"));
									controller.close();
								},
							}),
						},
					),
				/streaming request body requires a known content length/,
			);
			assert.equal(connected, false);
		},
	],
	[
		"falls back from socket transport before upstream response starts",
		async () => {
			let fetched = false;
			let fetchBody = "";
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					withFetch(
						async (_url, init = {}) => {
							fetched = true;
							fetchBody = init.body ? await new Response(init.body).text() : "";
							return new Response("fallback", { status: 202 });
						},
						async () => {
							mod._setConnectForTest(() => {
								const err = new Error("socket boom secret");
								err.code = "socket_boom";
								throw err;
							});
							const resp = await mod.httpFetch(
								"https://example.test/fallback",
								{
									method: "POST",
									body: "x",
									socket: true,
									timeoutMs: 100,
									cfg: { log_requests: true },
								},
							);
							assert.equal(fetched, true);
							assert.equal(resp.status, 202);
							assert.equal(await resp.text(), "fallback");

							fetched = false;
							mod._setConnectForTest(() => {
								const err = new Error("socket disabled secret");
								err.code = "socket_disabled";
								throw err;
							});
							await assert.rejects(
								() =>
									mod.httpFetch("https://example.test/no-policy-fallback", {
										method: "POST",
										body: "x",
										socket: true,
										socketFallback: "never",
										timeoutMs: 100,
										cfg: { log_requests: true },
									}),
								/socket disabled secret/,
							);
							assert.equal(fetched, false);

							mod._setConnectForTest(() => {
								const err = new Error("stream body socket secret");
								err.code = "socket_stream_body";
								throw err;
							});
							const streamFallback = await mod.httpFetch(
								"https://example.test/stream-body-fallback",
								{
									method: "POST",
									body: new ReadableStream({
										start(controller) {
											controller.enqueue(new TextEncoder().encode("x"));
											controller.close();
										},
									}),
									bodyLength: 1,
									socket: true,
									timeoutMs: 100,
									cfg: { log_requests: true },
								},
							);
							assert.equal(fetched, true);
							assert.equal(streamFallback.status, 202);
							assert.equal(fetchBody, "x");

							fetched = false;
							fetchBody = "";
							let writes = 0;
							mod._setConnectForTest(() => ({
								readable: new ReadableStream(),
								writable: new WritableStream({
									write() {
										writes += 1;
										if (writes === 2)
											throw new Error("stream body write secret");
									},
								}),
								close() {},
							}));
							await assert.rejects(
								() =>
									mod.httpFetch(
										"https://example.test/no-consumed-stream-body-fallback",
										{
											method: "POST",
											body: new ReadableStream({
												start(controller) {
													controller.enqueue(new TextEncoder().encode("x"));
													controller.close();
												},
											}),
											bodyLength: 1,
											socket: true,
											timeoutMs: 100,
											cfg: { log_requests: true },
										},
									),
								/stream body write secret/,
							);
							assert.equal(fetched, false);

							mod._setConnectForTest(() => {
								const err = new Error("upstream response started secret");
								err.code = "socket_response_started";
								err.upstreamStatus = 502;
								throw err;
							});
							await assert.rejects(
								() =>
									mod.httpFetch("https://example.test/no-fallback", {
										method: "POST",
										socket: true,
										timeoutMs: 100,
										cfg: { log_requests: true },
									}),
								/upstream response started secret/,
							);
							assert.equal(fetched, false);
							mod._setConnectForTest(null);
						},
					),
			);
			assert.equal(logs.length, 5);
			assert.match(
				logs[0],
				/falling back to fetch: type=Error code=socket_boom/,
			);
			assert.match(
				logs[1],
				/fallback disabled for POST: type=Error code=socket_disabled/,
			);
			assert.match(
				logs[2],
				/falling back to fetch: type=Error code=socket_stream_body/,
			);
			assert.match(
				logs[3],
				/not falling back with streaming request body for POST: type=Error/,
			);
			assert.match(
				logs[4],
				/not falling back after upstream response for POST: type=Error code=socket_response_started upstreamStatus=502/,
			);
			assert.doesNotMatch(
				logs.join("\n"),
				/socket boom secret|socket disabled secret|stream body socket secret|stream body write secret|upstream response started secret/,
			);
		},
	],
	[
		"renders upstream empty response warning without leaking build hints",
		async () => {
			assert.match(mod.EMPTY_UPSTREAM_MSG, /empty response/);
			assert.doesNotMatch(mod.EMPTY_UPSTREAM_MSG, /GEMINI_BL/);
			const warning = mod.upstreamEmptyWarning({ gemini_bl: "boq_test" });
			assert.equal(warning.code, "upstream_empty");
			assert.equal(warning.gemini_bl, "boq_test");
			assert.match(warning.hint, /diagnostics/);
		},
	],
	[
		"maps invalid Gemini cookie errors to OpenAI auth responses",
		async () => {
			const err = mod.invalidGeminiCookieError({ cookie: "SID=bad" }, 403, 123);
			assert.equal(err.code, "invalid_gemini_cookie");
			assert.equal(err.status, 401);
			assert.equal(err.upstreamStatus, 403);
			assert.equal(err.rawLength, 123);
			assert.equal(mod.isInvalidGeminiCookieError(err), true);
			assert.equal(mod.invalidGeminiCookieError({ cookie: "" }, 403), null);
			assert.equal(
				mod.invalidGeminiCookieError({ cookie: "SID=bad" }, 429),
				null,
			);

			const openAIResp = mod.openAIUpstreamErrorResponse(err);
			assert.equal(openAIResp.status, 401);
			const openAIBody = await openAIResp.json();
			assert.equal(openAIBody.error.code, "invalid_gemini_cookie");
			assert.equal(openAIBody.error.type, "authentication_error");
			const earlyErr = mod.invalidGeminiCookieError({ cookie: "SID=bad" }, 401);
			assert.equal(earlyErr.rawLength, null);
			const unverifiedErr = mod.unverifiedGeminiCookieError();
			assert.equal(unverifiedErr.code, "invalid_gemini_cookie");
			assert.equal(unverifiedErr.status, 401);
			const unverifiedResp = mod.openAIUpstreamErrorResponse(unverifiedErr);
			assert.equal(unverifiedResp.status, 401);
		},
	],
	[
		"coalesces stream deltas by field and flush threshold",
		async () => {
			const frames = [];
			const coalescer = mod.createDeltaCoalescer(
				(delta) => frames.push(delta),
				5,
				0,
			);
			coalescer.append("content", "hi");
			assert.deepEqual(frames, []);
			coalescer.append("content", "!");
			coalescer.append("tool_calls", "x");
			assert.deepEqual(frames, [{ content: "hi!" }]);
			coalescer.append("tool_calls", "yzabc");
			assert.deepEqual(frames, [{ content: "hi!" }, { tool_calls: "xyzabc" }]);
			coalescer.flush();
			assert.deepEqual(frames, [{ content: "hi!" }, { tool_calls: "xyzabc" }]);
		},
	],
	[
		"can emit the first stream delta immediately before throttling",
		async () => {
			const frames = [];
			const coalescer = mod.createDeltaCoalescer(
				(delta) => frames.push(delta),
				5,
				0,
				{ emitFirstImmediately: true },
			);
			coalescer.append("content", "hi");
			assert.deepEqual(frames, [{ content: "hi" }]);
			coalescer.append("content", "!");
			assert.deepEqual(frames, [{ content: "hi" }]);
			coalescer.flush();
			assert.deepEqual(frames, [{ content: "hi" }, { content: "!" }]);
		},
	],
	[
		"flushes buffered stream deltas after the coalescing timer",
		async () => {
			const frames = [];
			const coalescer = mod.createDeltaCoalescer(
				async (delta) => {
					frames.push(delta);
				},
				64,
				1,
			);
			coalescer.append("content", "hi");
			assert.deepEqual(frames, []);
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.deepEqual(frames, [{ content: "hi" }]);
		},
	],
	[
		"coalesces stream deltas after unknown input normalization",
		async () => {
			const frames = [];
			const coalescer = mod.createDeltaCoalescer(
				(delta) => frames.push(delta),
				16,
				0,
			);
			coalescer.append("content", "");
			coalescer.append("content", 0);
			coalescer.append("content", false);
			coalescer.append("content", null);
			coalescer.append("content", undefined);
			coalescer.flush();
			assert.deepEqual(frames, []);

			coalescer.append("content", { ok: true });
			assert.deepEqual(frames, []);
			coalescer.append("content", "!");
			assert.deepEqual(frames, [{ content: "[object Object]!" }]);

			coalescer.append("content", true);
			coalescer.flush();
			assert.deepEqual(frames, [
				{ content: "[object Object]!" },
				{ content: "true" },
			]);
		},
	],
	[
		"formats stream warning events with upstream code metadata",
		async () => {
			const err = new Error("socket reset");
			err.code = "socket_reset";
			const warning = mod.streamWarningObject(err, "partial output kept");
			assert.deepEqual(warning, {
				code: "socket_reset",
				message: "partial output kept",
			});
			assert.match(
				mod.streamErrorText(err),
				/upstream error: socket reset \[socket_reset\]/,
			);
			assert.match(
				mod.streamInterruptedWarningText(err),
				/stream interrupted after partial output: socket reset/,
			);

			const writes = [];
			mod.writeStreamWarningEvent(
				(chunk) => writes.push(chunk),
				err,
				"partial output kept",
			);
			assert.match(writes.join(""), /event: warning/);
			assert.match(writes.join(""), /"code":"socket_reset"/);
		},
	],
];

function geminiTextResponse(text) {
	const inner = [null, null, null, null, [[null, [text]]], "x".repeat(160)];
	return new Response(
		JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]),
		{ status: 200 },
	);
}

async function withoutTypedArrayHexMethod(run) {
	const toHexDescriptor = Object.getOwnPropertyDescriptor(
		Uint8Array.prototype,
		"toHex",
	);
	Object.defineProperty(Uint8Array.prototype, "toHex", {
		value: undefined,
		configurable: true,
		writable: true,
	});
	try {
		return await run();
	} finally {
		if (toHexDescriptor)
			Object.defineProperty(Uint8Array.prototype, "toHex", toHexDescriptor);
		else delete Uint8Array.prototype.toHex;
	}
}

async function gzipText(text) {
	const stream = new Blob([text])
		.stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concatBytes(...parts) {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}
