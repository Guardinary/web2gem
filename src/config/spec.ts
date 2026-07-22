import {
	configValue,
	parseCapabilityMode,
	parseHttpOrigin,
	parseKeyList,
	parseNonEmptyString,
	parseStrictBoolean,
	parseStrictInteger,
	parseString,
	parseZeroOrBoundedInteger,
} from "./parse";
import type { StaticRuntimeConfig, WorkerEnv } from "./types";

type MutableStaticRuntimeConfig = {
	-readonly [K in keyof StaticRuntimeConfig]: StaticRuntimeConfig[K];
};

type ConfigSpecEntry<K extends keyof StaticRuntimeConfig> = {
	key: keyof WorkerBindings;
	field: K;
	defaultValue: StaticRuntimeConfig[K];
	parse: (setting: string, value: unknown) => StaticRuntimeConfig[K];
};

type AnyConfigSpecEntry = {
	[K in keyof StaticRuntimeConfig]: ConfigSpecEntry<K>;
}[keyof StaticRuntimeConfig];

function configEntry<K extends keyof StaticRuntimeConfig>(
	key: keyof WorkerBindings,
	field: K,
	defaultValue: StaticRuntimeConfig[K],
	parse: ConfigSpecEntry<K>["parse"],
): ConfigSpecEntry<K> {
	return { key, field, defaultValue, parse };
}

const CONFIG_SPEC = [
	configEntry(
		"GEMINI_BL",
		"gemini_bl",
		"boq_assistant-bard-web-server_20260709.09_p0",
		(setting, value) => parseNonEmptyString(setting, value, 512),
	),
	configEntry(
		"GEMINI_ORIGIN",
		"gemini_origin",
		"https://gemini.google.com",
		parseHttpOrigin,
	),
	configEntry("UPSTREAM_SOCKET", "upstream_socket", true, parseStrictBoolean),
	configEntry(
		"DEFAULT_MODEL",
		"default_model",
		"gemini-3.5-flash",
		(setting, value) => parseNonEmptyString(setting, value, 256),
	),
	configEntry("RETRY_ATTEMPTS", "retry_attempts", 3, (setting, value) =>
		parseStrictInteger(setting, value, 1, 10),
	),
	configEntry(
		"GEMINI_ACCOUNT_MAX_ATTEMPTS",
		"gemini_account_max_attempts",
		10,
		(setting, value) =>
			parseStrictInteger(setting, value, 1, Number.MAX_SAFE_INTEGER),
	),
	configEntry(
		"GEMINI_ACCOUNT_REFRESH_INTERVAL_SEC",
		"gemini_account_refresh_interval_sec",
		600,
		(setting, value) =>
			parseZeroOrBoundedInteger(setting, value, 60, 7 * 24 * 60 * 60),
	),
	configEntry(
		"GEMINI_ACCOUNT_CAPABILITY_TTL_SEC",
		"gemini_account_capability_ttl_sec",
		3600,
		(setting, value) =>
			parseStrictInteger(setting, value, 60, 7 * 24 * 60 * 60),
	),
	configEntry(
		"GEMINI_ACCOUNT_CAPABILITY_MODE",
		"gemini_account_capability_mode",
		"prefer",
		parseCapabilityMode,
	),
	configEntry("RETRY_DELAY_SEC", "retry_delay_sec", 2, (setting, value) =>
		parseStrictInteger(setting, value, 0, 60),
	),
	configEntry(
		"REQUEST_TIMEOUT_SEC",
		"request_timeout_sec",
		180,
		(setting, value) => parseStrictInteger(setting, value, 1, 3600),
	),
	configEntry(
		"REQUEST_BODY_MAX_BYTES",
		"request_body_max_bytes",
		16 * 1024 * 1024,
		(setting, value) =>
			parseStrictInteger(setting, value, 1, 100 * 1024 * 1024),
	),
	configEntry("LOG_REQUESTS", "log_requests", false, parseStrictBoolean),
	configEntry(
		"CURRENT_INPUT_FILE_ENABLED",
		"current_input_file_enabled",
		true,
		parseStrictBoolean,
	),
	configEntry(
		"CURRENT_INPUT_FILE_MIN_BYTES",
		"current_input_file_min_bytes",
		95000,
		(setting, value) => parseStrictInteger(setting, value, 0, 10 * 1024 * 1024),
	),
	configEntry(
		"GENERIC_FILE_UPLOAD_MAX_BYTES",
		"generic_file_upload_max_bytes",
		20 * 1024 * 1024,
		(setting, value) =>
			parseStrictInteger(setting, value, 0, 100 * 1024 * 1024),
	),
	configEntry(
		"API_KEYS",
		"api_keys",
		[] as readonly string[],
		(setting, value) => Object.freeze(parseKeyList(setting, value)),
	),
	configEntry("ADMIN_KEY", "admin_key", "", parseString),
] as const satisfies readonly AnyConfigSpecEntry[];

export const CONFIG_ENV_KEYS = Object.freeze(
	CONFIG_SPEC.map((entry) => entry.key),
);

export type ConfigCacheSnapshot = readonly unknown[];

export function parseStaticRuntimeConfig(env: WorkerEnv): StaticRuntimeConfig {
	const out: Partial<MutableStaticRuntimeConfig> = {};
	for (const entry of CONFIG_SPEC) assignConfigValue(out, entry, env);
	return Object.freeze(out as StaticRuntimeConfig);
}

function assignConfigValue<K extends keyof StaticRuntimeConfig>(
	out: Partial<MutableStaticRuntimeConfig>,
	entry: ConfigSpecEntry<K>,
	env: WorkerEnv,
): void {
	out[entry.field] = entry.parse(
		entry.key,
		configValue(env, entry.key, entry.defaultValue),
	);
}

export function captureConfigSnapshot(env: WorkerEnv): ConfigCacheSnapshot {
	return CONFIG_SPEC.map((entry) => snapshotValue(entry.key, env[entry.key]));
}

export function configSnapshotMatches(
	snapshot: ConfigCacheSnapshot,
	env: WorkerEnv,
): boolean {
	if (snapshot.length !== CONFIG_SPEC.length) return false;
	for (let index = 0; index < CONFIG_SPEC.length; index++) {
		const entry = CONFIG_SPEC[index];
		if (!entry) return false;
		if (!snapshotValueMatches(snapshot[index], env[entry.key])) return false;
	}
	return true;
}

function snapshotValue(key: keyof WorkerBindings, value: unknown): unknown {
	return key === "API_KEYS" && Array.isArray(value)
		? Object.freeze([...value])
		: value;
}

function snapshotValueMatches(expected: unknown, actual: unknown): boolean {
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual) || actual.length !== expected.length)
			return false;
		for (let index = 0; index < expected.length; index++) {
			if (!Object.is(actual[index], expected[index])) return false;
		}
		return true;
	}
	return Object.is(actual, expected);
}
