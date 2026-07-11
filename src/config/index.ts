export const VERSION = "2.0.0-worker";

type WorkerEnvKey = keyof WorkerBindings | "ADMIN_KEYS";

export type WorkerEnv = Partial<Record<WorkerEnvKey, unknown>>;

export type RuntimeProfile = "worker" | "docker";

export type GeminiAccountRuntimeContext = {
	accountId: string;
	cookieHash: string;
	rowId?: string;
};

export type GeminiAccountPageStateWriteback = {
	cookieHeader?: string | undefined;
	sapisid?: string | null | undefined;
	sessionToken?: string | null | undefined;
	sessionId?: string | null | undefined;
	language?: string | null | undefined;
	pushId?: string | null | undefined;
	nowMs?: number;
};

export type StaticRuntimeConfig = Readonly<{
	gemini_bl: string;
	gemini_origin: string;
	upstream_socket: boolean;
	default_model: string;
	retry_attempts: number;
	retry_delay_sec: number;
	request_timeout_sec: number;
	request_body_max_bytes: number;
	log_requests: boolean;
	current_input_file_enabled: boolean;
	current_input_file_min_bytes: number;
	current_input_file_name: string;
	current_tools_file_name: string;
	generic_file_upload_max_bytes: number;
	api_keys: readonly string[];
	admin_key: string;
}>;

export type RuntimeExecutionContext = {
	supports_authenticated_session?: boolean;
	execution_ctx?: Pick<ExecutionContext, "waitUntil">;
	runtime_profile?: RuntimeProfile;
};

export type GeminiAccountSessionContext = {
	cookie: string;
	sapisid: string;
	gemini_account?: GeminiAccountRuntimeContext;
	gemini_account_writeback?: (
		update: GeminiAccountPageStateWriteback,
	) => Promise<unknown>;
};

export type RuntimeConfig = StaticRuntimeConfig &
	RuntimeExecutionContext &
	GeminiAccountSessionContext;

export function createRuntimeConfig(
	config: StaticRuntimeConfig,
	execution: RuntimeExecutionContext = {},
	session: Partial<GeminiAccountSessionContext> = {},
): RuntimeConfig {
	return {
		...config,
		...execution,
		...session,
		cookie: session.cookie ?? "",
		sapisid: session.sapisid ?? "",
	};
}

const DEFAULT_CONFIG = Object.freeze({
	GEMINI_BL: "boq_assistant-bard-web-server_20260618.10_p0",
	GEMINI_ORIGIN: "https://gemini.google.com",
	UPSTREAM_SOCKET: true,
	DEFAULT_MODEL: "gemini-3.5-flash",
	RETRY_ATTEMPTS: 3,
	RETRY_DELAY_SEC: 2,
	REQUEST_TIMEOUT_SEC: 180,
	REQUEST_BODY_MAX_BYTES: 16 * 1024 * 1024,
	LOG_REQUESTS: false,
	CURRENT_INPUT_FILE_ENABLED: true,
	CURRENT_INPUT_FILE_MIN_BYTES: 95000,
	CURRENT_INPUT_FILE_NAME: "message.txt",
	CURRENT_TOOLS_FILE_NAME: "tools.txt",
	GENERIC_FILE_UPLOAD_MAX_BYTES: 20 * 1024 * 1024,
	API_KEYS: [] as string[],
	ADMIN_KEY: "",
});

export class RuntimeConfigError extends Error {
	readonly code = "invalid_runtime_config";

	constructor(
		readonly setting: string,
		readonly reason: string,
	) {
		super(`invalid runtime configuration: ${setting} ${reason}`);
		this.name = "RuntimeConfigError";
	}
}

const PLACEHOLDER_ADMIN_KEY_VALUES = new Set([
	"admin",
	"changeme",
	"change-me",
	"example",
	"password",
	"sample",
	"test",
	"your-admin-key",
]);

export function parseAdminKey(value: unknown, removedPlural?: unknown): string {
	if (
		removedPlural !== undefined &&
		removedPlural !== null &&
		removedPlural !== ""
	)
		throw new RuntimeConfigError(
			"ADMIN_KEYS",
			"is no longer supported; use ADMIN_KEY",
		);
	if (typeof value !== "string")
		throw new RuntimeConfigError("ADMIN_KEY", "must be a string");
	const key = value.trim();
	if (!key) return "";
	if (key.length > 4096)
		throw new RuntimeConfigError(
			"ADMIN_KEY",
			"must not be longer than 4096 characters",
		);
	if (PLACEHOLDER_ADMIN_KEY_VALUES.has(key.toLowerCase()))
		throw new RuntimeConfigError("ADMIN_KEY", "must not be a placeholder key");
	return key;
}

export const CONFIG_ENV_KEYS = [
	"GEMINI_BL",
	"GEMINI_ORIGIN",
	"UPSTREAM_SOCKET",
	"DEFAULT_MODEL",
	"RETRY_ATTEMPTS",
	"RETRY_DELAY_SEC",
	"REQUEST_TIMEOUT_SEC",
	"REQUEST_BODY_MAX_BYTES",
	"LOG_REQUESTS",
	"CURRENT_INPUT_FILE_ENABLED",
	"CURRENT_INPUT_FILE_MIN_BYTES",
	"CURRENT_INPUT_FILE_NAME",
	"CURRENT_TOOLS_FILE_NAME",
	"GENERIC_FILE_UPLOAD_MAX_BYTES",
	"API_KEYS",
	"ADMIN_KEY",
] as const;
const CONFIG_CACHE_ENV_KEYS = [...CONFIG_ENV_KEYS, "ADMIN_KEYS"] as const;
let _configCacheKey: string | null = null;
let _configCacheValue: StaticRuntimeConfig | null = null;
let _configCacheEnv: WorkerEnv | null = null;
const DEFAULT_ENV: WorkerEnv = {};
type ConfigCacheEntry = { key: string; value: StaticRuntimeConfig };
const _configCacheByEnv = new WeakMap<WorkerEnv, ConfigCacheEntry>();

export function configCacheKey(env: WorkerEnv = DEFAULT_ENV): string {
	const activeEnv = env || DEFAULT_ENV;
	let out = "";
	for (const key of CONFIG_CACHE_ENV_KEYS) {
		const value = activeEnv[key];
		out += `${key}\x00${serializeConfigValue(value)}\x01`;
	}
	return out;
}

export function getConfig(env: WorkerEnv = DEFAULT_ENV): StaticRuntimeConfig {
	const activeEnv = env || DEFAULT_ENV;
	const cacheKey = configCacheKey(activeEnv);
	if (
		_configCacheValue &&
		_configCacheEnv === activeEnv &&
		_configCacheKey === cacheKey
	)
		return _configCacheValue;
	const cachedByEnv = _configCacheByEnv.get(activeEnv);
	if (cachedByEnv && cachedByEnv.key === cacheKey) {
		_configCacheEnv = activeEnv;
		_configCacheKey = cacheKey;
		_configCacheValue = cachedByEnv.value;
		return cachedByEnv.value;
	}
	if (_configCacheValue && _configCacheKey === cacheKey) {
		_configCacheEnv = activeEnv;
		_configCacheByEnv.set(activeEnv, {
			key: cacheKey,
			value: _configCacheValue,
		});
		return _configCacheValue;
	}
	const cfg: StaticRuntimeConfig = Object.freeze({
		gemini_bl: parseNonEmptyString(
			"GEMINI_BL",
			configValue(activeEnv, "GEMINI_BL", DEFAULT_CONFIG.GEMINI_BL),
			512,
		),
		gemini_origin: parseHttpOrigin(
			"GEMINI_ORIGIN",
			configValue(activeEnv, "GEMINI_ORIGIN", DEFAULT_CONFIG.GEMINI_ORIGIN),
		),
		upstream_socket: parseStrictBoolean(
			"UPSTREAM_SOCKET",
			configValue(activeEnv, "UPSTREAM_SOCKET", DEFAULT_CONFIG.UPSTREAM_SOCKET),
		),
		default_model: parseNonEmptyString(
			"DEFAULT_MODEL",
			configValue(activeEnv, "DEFAULT_MODEL", DEFAULT_CONFIG.DEFAULT_MODEL),
			256,
		),
		retry_attempts: parseStrictInteger(
			"RETRY_ATTEMPTS",
			configValue(activeEnv, "RETRY_ATTEMPTS", DEFAULT_CONFIG.RETRY_ATTEMPTS),
			1,
			10,
		),
		retry_delay_sec: parseStrictInteger(
			"RETRY_DELAY_SEC",
			configValue(activeEnv, "RETRY_DELAY_SEC", DEFAULT_CONFIG.RETRY_DELAY_SEC),
			0,
			60,
		),
		request_timeout_sec: parseStrictInteger(
			"REQUEST_TIMEOUT_SEC",
			configValue(
				activeEnv,
				"REQUEST_TIMEOUT_SEC",
				DEFAULT_CONFIG.REQUEST_TIMEOUT_SEC,
			),
			1,
			3600,
		),
		request_body_max_bytes: parseStrictInteger(
			"REQUEST_BODY_MAX_BYTES",
			configValue(
				activeEnv,
				"REQUEST_BODY_MAX_BYTES",
				DEFAULT_CONFIG.REQUEST_BODY_MAX_BYTES,
			),
			1,
			100 * 1024 * 1024,
		),
		log_requests: parseStrictBoolean(
			"LOG_REQUESTS",
			configValue(activeEnv, "LOG_REQUESTS", DEFAULT_CONFIG.LOG_REQUESTS),
		),
		current_input_file_enabled: parseStrictBoolean(
			"CURRENT_INPUT_FILE_ENABLED",
			configValue(
				activeEnv,
				"CURRENT_INPUT_FILE_ENABLED",
				DEFAULT_CONFIG.CURRENT_INPUT_FILE_ENABLED,
			),
		),
		current_input_file_min_bytes: parseStrictInteger(
			"CURRENT_INPUT_FILE_MIN_BYTES",
			configValue(
				activeEnv,
				"CURRENT_INPUT_FILE_MIN_BYTES",
				DEFAULT_CONFIG.CURRENT_INPUT_FILE_MIN_BYTES,
			),
			0,
			10 * 1024 * 1024,
		),
		current_input_file_name: parseFilename(
			"CURRENT_INPUT_FILE_NAME",
			configValue(
				activeEnv,
				"CURRENT_INPUT_FILE_NAME",
				DEFAULT_CONFIG.CURRENT_INPUT_FILE_NAME,
			),
		),
		current_tools_file_name: parseFilename(
			"CURRENT_TOOLS_FILE_NAME",
			configValue(
				activeEnv,
				"CURRENT_TOOLS_FILE_NAME",
				DEFAULT_CONFIG.CURRENT_TOOLS_FILE_NAME,
			),
		),
		generic_file_upload_max_bytes: parseStrictInteger(
			"GENERIC_FILE_UPLOAD_MAX_BYTES",
			configValue(
				activeEnv,
				"GENERIC_FILE_UPLOAD_MAX_BYTES",
				DEFAULT_CONFIG.GENERIC_FILE_UPLOAD_MAX_BYTES,
			),
			0,
			100 * 1024 * 1024,
		),
		api_keys: Object.freeze(
			parseKeyList(
				"API_KEYS",
				configValue(activeEnv, "API_KEYS", DEFAULT_CONFIG.API_KEYS),
			),
		),
		admin_key: parseAdminKey(
			configValue(activeEnv, "ADMIN_KEY", DEFAULT_CONFIG.ADMIN_KEY),
			activeEnv.ADMIN_KEYS,
		),
	});
	_configCacheKey = cacheKey;
	_configCacheValue = cfg;
	_configCacheEnv = activeEnv;
	_configCacheByEnv.set(activeEnv, { key: cacheKey, value: cfg });
	return cfg;
}

export function assertRuntimeConfig(env: WorkerEnv = DEFAULT_ENV): void {
	void getConfig(env);
}

function configValue(
	env: WorkerEnv,
	key: WorkerEnvKey,
	fallback: unknown,
): unknown {
	const value = env[key];
	return value === undefined || value === null || value === ""
		? fallback
		: value;
}

function parseStrictBoolean(setting: string, value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new RuntimeConfigError(setting, "must be true or false");
}

function parseStrictInteger(
	setting: string,
	value: unknown,
	min: number,
	max: number,
): number {
	let parsed: number;
	if (typeof value === "number") {
		parsed = value;
	} else if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
		parsed = Number(value);
	} else {
		throw new RuntimeConfigError(
			setting,
			`must be an integer between ${min} and ${max}`,
		);
	}
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new RuntimeConfigError(
			setting,
			`must be an integer between ${min} and ${max}`,
		);
	}
	return parsed;
}

function parseNonEmptyString(
	setting: string,
	value: unknown,
	maxLength: number,
): string {
	if (typeof value !== "string")
		throw new RuntimeConfigError(setting, "must be a string");
	const parsed = value.trim();
	if (!parsed) throw new RuntimeConfigError(setting, "must not be empty");
	if (parsed.length > maxLength)
		throw new RuntimeConfigError(
			setting,
			`must be at most ${maxLength} characters`,
		);
	return parsed;
}

function parseHttpOrigin(setting: string, value: unknown): string {
	const raw = parseNonEmptyString(setting, value, 2048);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch (_) {
		throw new RuntimeConfigError(setting, "must be an absolute HTTP(S) origin");
	}
	if (
		(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash
	) {
		throw new RuntimeConfigError(setting, "must be an absolute HTTP(S) origin");
	}
	return parsed.origin;
}

function parseFilename(setting: string, value: unknown): string {
	const parsed = parseNonEmptyString(setting, value, 255);
	if (
		/[/\\\u0000-\u001f\u007f]/.test(parsed) ||
		parsed === "." ||
		parsed === ".."
	)
		throw new RuntimeConfigError(setting, "must be a plain filename");
	return parsed;
}

function parseKeyList(setting: string, value: unknown): string[] {
	let items: unknown[];
	if (Array.isArray(value)) {
		items = value;
	} else if (typeof value === "string") {
		const raw = value.trim();
		if (!raw) return [];
		if (raw.startsWith("["))
			throw new RuntimeConfigError(setting, "must be a comma-separated list");
		items = raw.split(",");
	} else {
		throw new RuntimeConfigError(setting, "must be a comma-separated list");
	}
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (typeof item !== "string")
			throw new RuntimeConfigError(setting, "must contain only strings");
		const key = item.trim();
		if (!key)
			throw new RuntimeConfigError(setting, "must not contain empty entries");
		if (key.length > 4096)
			throw new RuntimeConfigError(
				setting,
				"contains an entry longer than 4096 characters",
			);
		if (seen.has(key))
			throw new RuntimeConfigError(
				setting,
				"must not contain duplicate entries",
			);
		seen.add(key);
		out.push(key);
	}
	return out;
}

function serializeConfigValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "string") return `string:${value}`;
	if (typeof value === "number") return `number:${value}`;
	if (typeof value === "boolean") return `boolean:${value}`;
	try {
		return `json:${JSON.stringify(value)}`;
	} catch (_) {
		return `other:${String(value)}`;
	}
}
