import { describe, test } from "vitest";
import {
	assertRuntimeConfig,
	createRuntimeConfig,
	getConfig,
} from "../../../src/config";
import { assert } from "../assertions.js";

describe("runtime configuration", () => {
	test("parses LOG_REQUESTS boolean config", () => {
		assert.equal(getConfig({}).log_requests, false);
		assert.equal(getConfig({}).request_body_max_bytes, 16 * 1024 * 1024);
		assert.equal(getConfig({ LOG_REQUESTS: "false" }).log_requests, false);
		assert.equal(getConfig({ LOG_REQUESTS: "true" }).log_requests, true);
	});
	test("recomputes config when a reused env object changes", () => {
		const env = {
			LOG_REQUESTS: "false",
			GENERIC_FILE_UPLOAD_MAX_BYTES: "123",
		};
		assert.equal(getConfig(env).log_requests, false);
		assert.equal(getConfig(env).generic_file_upload_max_bytes, 123);
		env.LOG_REQUESTS = "true";
		env.GENERIC_FILE_UPLOAD_MAX_BYTES = "456";
		assert.equal(getConfig(env).log_requests, true);
		assert.equal(getConfig(env).generic_file_upload_max_bytes, 456);
	});
	test("reuses config cache entries after switching env objects", () => {
		const envA = { LOG_REQUESTS: "true" };
		const envB = { LOG_REQUESTS: "false" };
		const cfgA = getConfig(envA);
		const cfgB = getConfig(envB);
		assert.equal(cfgA === cfgB, false);
		assert.equal(getConfig(envA), cfgA);
	});
	test("recomputes config after mutating array-form API keys in place", () => {
		const env = { API_KEYS: ["sk-one", "sk-two"] };
		const first = getConfig(env);
		assert.deepEqual(first.api_keys, ["sk-one", "sk-two"]);
		env.API_KEYS[1] = "sk-three";
		const changed = getConfig(env);
		assert.equal(changed === first, false);
		assert.deepEqual(changed.api_keys, ["sk-one", "sk-three"]);
		env.API_KEYS.push("sk-four");
		assert.deepEqual(getConfig(env).api_keys, [
			"sk-one",
			"sk-three",
			"sk-four",
		]);
	});
	test("parses strict comma-separated and JSON-array API key config", () => {
		assert.deepEqual(getConfig({}).api_keys, []);
		assert.deepEqual(getConfig({ API_KEYS: "sk-one, sk-two" }).api_keys, [
			"sk-one",
			"sk-two",
		]);
		assert.deepEqual(getConfig({ API_KEYS: ["sk-array", "sk-two"] }).api_keys, [
			"sk-array",
			"sk-two",
		]);
		assert.deepEqual(
			getConfig({ API_KEYS: '["sk-json", "sk-two"]' }).api_keys,
			["sk-json", "sk-two"],
		);
		assert.throws(
			() => getConfig({ API_KEYS: '["sk-json", null]' }),
			/API_KEYS must contain only strings/,
		);
		assert.throws(
			() => getConfig({ API_KEYS: '["sk-json", ""]' }),
			/API_KEYS must not contain empty entries/,
		);
		assert.throws(
			() => getConfig({ API_KEYS: '["sk-json", "sk-json"]' }),
			/API_KEYS must not contain duplicate entries/,
		);
		assert.throws(
			() => getConfig({ API_KEYS: "sk-one,,sk-two" }),
			/API_KEYS must not contain empty entries/,
		);
		assert.throws(
			() => getConfig({ API_KEYS: "sk-one,sk-one" }),
			/API_KEYS must not contain duplicate entries/,
		);
	});
	test("parses ADMIN_KEY as an ordinary string setting", () => {
		assert.equal(
			getConfig({ ADMIN_KEY: " admin-secret " }).admin_key,
			" admin-secret ",
		);
		assert.equal(getConfig({ ADMIN_KEY: "password" }).admin_key, "password");
		const longKey = "a".repeat(4097);
		assert.equal(getConfig({ ADMIN_KEY: longKey }).admin_key, longKey);
		assert.throws(
			() => getConfig({ ADMIN_KEY: ["first", "second"] }),
			/ADMIN_KEY must be a string/,
		);
		const env = { ADMIN_KEY: "first" };
		const first = getConfig(env);
		env.ADMIN_KEY = "second";
		const second = getConfig(env);
		assert.equal(second.admin_key, "second");
		assert.equal(first === second, false);
		assert.equal(getConfig({ ADMIN_KEY: "" }).admin_key, "");
	});
	test("keeps cached static config separate from request and account context", () => {
		const staticConfig = getConfig({
			GEMINI_COOKIE:
				"__Secure-1PSID=psid; SAPISID=sapi-from-cookie; __Secure-1PSIDTS=ts",
			SAPISID: "",
		});
		assert.equal(Object.hasOwn(staticConfig, "cookie"), false);
		assert.equal(Object.hasOwn(staticConfig, "execution_ctx"), false);
		const executionContext = { waitUntil() {} };
		const runtimeConfig = createRuntimeConfig(
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
		const emptySession = createRuntimeConfig(staticConfig);
		assert.equal(emptySession.cookie, "");
		assert.equal(emptySession.sapisid, "");
		assert.equal(Object.isFrozen(staticConfig), true);
		assert.equal(Object.isFrozen(staticConfig.api_keys), true);
		assert.equal(staticConfig.admin_key, "");
	});
	test("rejects malformed and out-of-range runtime config", () => {
		for (const env of [
			{ GEMINI_BL: 1 },
			{ DEFAULT_MODEL: "x".repeat(257) },
			{ GEMINI_ORIGIN: "not a URL" },
			{ LOG_REQUESTS: "yes" },
			{ RETRY_ATTEMPTS: "0" },
			{ GEMINI_ACCOUNT_MAX_ATTEMPTS: "0" },
			{ GEMINI_ACCOUNT_REFRESH_INTERVAL_SEC: "1" },
			{ GEMINI_ACCOUNT_CAPABILITY_TTL_SEC: "59" },
			{ GEMINI_ACCOUNT_CAPABILITY_MODE: "invalid" },
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
			assert.throws(() => getConfig(env), /invalid runtime configuration/);
		}
		const cfg = getConfig({
			RETRY_ATTEMPTS: "10",
			GEMINI_ACCOUNT_MAX_ATTEMPTS: "999999",
			GEMINI_ACCOUNT_REFRESH_INTERVAL_SEC: "0",
			GEMINI_ACCOUNT_CAPABILITY_TTL_SEC: "604800",
			GEMINI_ACCOUNT_CAPABILITY_MODE: "strict",
			RETRY_DELAY_SEC: "0",
			REQUEST_TIMEOUT_SEC: "3600",
			REQUEST_BODY_MAX_BYTES: "104857600",
			CURRENT_INPUT_FILE_MIN_BYTES: "0",
			GENERIC_FILE_UPLOAD_MAX_BYTES: "104857600",
		});
		assert.equal(cfg.retry_attempts, 10);
		assert.equal(cfg.gemini_account_max_attempts, 999999);
		assert.equal(cfg.gemini_account_refresh_interval_sec, 0);
		assert.equal(cfg.gemini_account_capability_ttl_sec, 604800);
		assert.equal(cfg.gemini_account_capability_mode, "strict");
		assert.equal(cfg.retry_delay_sec, 0);
		assert.equal(cfg.request_timeout_sec, 3600);
		assert.equal(cfg.request_body_max_bytes, 104857600);
		assert.equal(cfg.current_input_file_min_bytes, 0);
		assert.equal(cfg.generic_file_upload_max_bytes, 104857600);
		assert.equal(assertRuntimeConfig({ LOG_REQUESTS: "true" }), undefined);
	});
});
