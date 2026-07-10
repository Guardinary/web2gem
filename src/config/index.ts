export const VERSION = "1.1.0-worker";

export type WorkerEnv = Record<string, unknown>;

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

export type RuntimeConfig = {
	gemini_bl: string;
	gemini_origin: string;
	upstream_socket: boolean;
	default_model: string;
	retry_attempts: number;
	retry_delay_sec: number;
	request_timeout_sec: number;
	log_requests: boolean;
	current_input_file_enabled: boolean;
	current_input_file_min_bytes: number;
	current_input_file_name: string;
	current_tools_file_name: string;
	generic_file_upload_max_bytes: number;
	api_keys: string[];
	admin_keys: string[];
	cookie: string;
	sapisid: string;
	supports_authenticated_session?: boolean;
	gemini_account?: GeminiAccountRuntimeContext;
	gemini_account_writeback?: (
		update: GeminiAccountPageStateWriteback,
	) => Promise<unknown>;
	execution_ctx?: Pick<ExecutionContext, "waitUntil">;
};

// ════════════════════════════════════════════════════════════════════════════
//  CONFIG —— 改这些值,然后直接部署本文件。
//  若设置了同名的 Worker 环境变量 / secret,会覆盖这里的值;不设则用此处的值。
// ════════════════════════════════════════════════════════════════════════════
export const CONFIG = {
	// 调用方必须携带的密钥(Authorization: Bearer <key> 或 x-api-key: <key>)。
	// 空数组 = 不鉴权(任何知道地址的人都能调用)。
	API_KEYS: [""],
	ADMIN_KEYS: [""],
	ADMIN_KEY: "",

	// Gemini 网页版构建号。如果返回开始变空,去 gemini.google.com 页面源码里
	// 找一个新的值("boq_assistant-bard-web-server_...")。
	GEMINI_BL: "boq_assistant-bard-web-server_20260618.10_p0",

	// 上游源站。默认直连 gemini.google.com。若部署在 Cloudflare/无服务器平台
	// 被 Google 以 429 限流(出口 IP 被拦),把它指向一个跑在“干净 IP”上的反向
	// 代理(转发到 gemini.google.com 并保留 Host/Origin),即可绕开。例:
	//   GEMINI_ORIGIN = "https://your-relay.example.com"
	GEMINI_ORIGIN: "https://gemini.google.com",

	// 上游请求是否优先用裸 socket(cloudflare:sockets)绕开 fetch 的 429 限流。
	// true=优先 socket,不可用/失败再回退 fetch;false=只用 fetch。
	UPSTREAM_SOCKET: true,

	DEFAULT_MODEL: "gemini-3.5-flash",
	RETRY_ATTEMPTS: 3,
	RETRY_DELAY_SEC: 2,
	REQUEST_TIMEOUT_SEC: 180,
	LOG_REQUESTS: false,

	// Pass large request context as Gemini text attachments only when the inline
	// prompt is larger than CURRENT_INPUT_FILE_MIN_BYTES and an authenticated
	// Gemini account-pool session is available.
	CURRENT_INPUT_FILE_ENABLED: true,
	CURRENT_INPUT_FILE_MIN_BYTES: 95000,
	CURRENT_INPUT_FILE_NAME: "message.txt",
	CURRENT_TOOLS_FILE_NAME: "tools.txt",
	GENERIC_FILE_UPLOAD_MAX_BYTES: 20 * 1024 * 1024,
};

// ─── 配置 ──────────────────────────────────────────────────────────────────
export function parseBool(v: unknown, def: boolean): boolean {
	if (v === undefined || v === null || v === "") return def;
	return /^(1|true|yes|on)$/i.test(String(v));
}

export function parseIntDefault(v: unknown, def: number): number {
	const n = Number.parseInt(String(v), 10);
	return Number.isFinite(n) ? n : def;
}

export function parseIntMin(v: unknown, def: number, min: number): number {
	return Math.max(min, parseIntDefault(v, def));
}

export function parseApiKeys(v: unknown): string[] {
	if (!v) return [];
	if (Array.isArray(v)) return normalizeApiKeyArray(v);
	const raw = String(v).trim();
	if (raw.startsWith("[")) {
		try {
			const arr = JSON.parse(raw);
			if (Array.isArray(arr)) return normalizeApiKeyArray(arr);
		} catch (_) {
			/* 继续往下走 */
		}
	}
	return raw
		.split(",")
		.map((s: string) => s.trim())
		.filter(Boolean);
}

const PLACEHOLDER_ADMIN_KEYS = new Set([
	"admin",
	"changeme",
	"change-me",
	"example",
	"password",
	"sample",
	"test",
	"your-admin-key",
]);

export function parseAdminKeys(primary: unknown, legacy?: unknown): string[] {
	const keys = [...parseApiKeys(primary), ...parseApiKeys(legacy)];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const key of keys) {
		const trimmed = String(key || "").trim();
		if (!trimmed) continue;
		if (PLACEHOLDER_ADMIN_KEYS.has(trimmed.toLowerCase())) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function normalizeApiKeyArray(items: unknown[]): string[] {
	return items
		.map((item: unknown) => (item == null ? "" : String(item).trim()))
		.filter(Boolean);
}

// 当 env[key] 设置了非空值时返回它,否则返回内嵌的默认值。
export function envOr(env: WorkerEnv, key: string, fallback: unknown): unknown {
	const v = env[key];
	return v !== undefined && v !== null && v !== "" ? v : fallback;
}

export const CONFIG_ENV_KEYS = [
	"GEMINI_BL",
	"GEMINI_ORIGIN",
	"UPSTREAM_SOCKET",
	"DEFAULT_MODEL",
	"RETRY_ATTEMPTS",
	"RETRY_DELAY_SEC",
	"REQUEST_TIMEOUT_SEC",
	"LOG_REQUESTS",
	"CURRENT_INPUT_FILE_ENABLED",
	"CURRENT_INPUT_FILE_MIN_BYTES",
	"CURRENT_INPUT_FILE_NAME",
	"CURRENT_TOOLS_FILE_NAME",
	"GENERIC_FILE_UPLOAD_MAX_BYTES",
	"API_KEYS",
	"ADMIN_KEYS",
	"ADMIN_KEY",
];
export let _configCacheKey: string | null = null;
export let _configCacheValue: RuntimeConfig | null = null;
let _configCacheEnv: WorkerEnv | null = null;
const DEFAULT_ENV: WorkerEnv = {};
type ConfigCacheEntry = { key: string; value: RuntimeConfig };
const _configCacheByEnv = new WeakMap<WorkerEnv, ConfigCacheEntry>();

export function configCacheKey(env: WorkerEnv = DEFAULT_ENV): string {
	const activeEnv = env || DEFAULT_ENV;
	let out = "";
	for (const key of CONFIG_ENV_KEYS) {
		const value = activeEnv[key];
		out += `${key}\x00${value === undefined || value === null ? "" : String(value)}\x01`;
	}
	return out;
}

export function getConfig(env: WorkerEnv = DEFAULT_ENV): RuntimeConfig {
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
	const cfg = {
		gemini_bl: String(envOr(activeEnv, "GEMINI_BL", CONFIG.GEMINI_BL)),
		gemini_origin: String(
			envOr(activeEnv, "GEMINI_ORIGIN", CONFIG.GEMINI_ORIGIN),
		).replace(/\/$/, ""),
		upstream_socket: parseBool(
			envOr(activeEnv, "UPSTREAM_SOCKET", CONFIG.UPSTREAM_SOCKET),
			true,
		),
		default_model: String(
			envOr(activeEnv, "DEFAULT_MODEL", CONFIG.DEFAULT_MODEL),
		),
		retry_attempts: parseIntMin(
			envOr(activeEnv, "RETRY_ATTEMPTS", CONFIG.RETRY_ATTEMPTS),
			3,
			1,
		),
		retry_delay_sec: parseIntMin(
			envOr(activeEnv, "RETRY_DELAY_SEC", CONFIG.RETRY_DELAY_SEC),
			2,
			0,
		),
		request_timeout_sec: parseIntMin(
			envOr(activeEnv, "REQUEST_TIMEOUT_SEC", CONFIG.REQUEST_TIMEOUT_SEC),
			180,
			1,
		),
		log_requests: parseBool(
			envOr(activeEnv, "LOG_REQUESTS", CONFIG.LOG_REQUESTS),
			false,
		),
		current_input_file_enabled: parseBool(
			envOr(
				activeEnv,
				"CURRENT_INPUT_FILE_ENABLED",
				CONFIG.CURRENT_INPUT_FILE_ENABLED,
			),
			true,
		),
		current_input_file_min_bytes: parseIntMin(
			envOr(
				activeEnv,
				"CURRENT_INPUT_FILE_MIN_BYTES",
				CONFIG.CURRENT_INPUT_FILE_MIN_BYTES,
			),
			CONFIG.CURRENT_INPUT_FILE_MIN_BYTES,
			0,
		),
		current_input_file_name: String(
			envOr(
				activeEnv,
				"CURRENT_INPUT_FILE_NAME",
				CONFIG.CURRENT_INPUT_FILE_NAME,
			),
		),
		current_tools_file_name: String(
			envOr(
				activeEnv,
				"CURRENT_TOOLS_FILE_NAME",
				CONFIG.CURRENT_TOOLS_FILE_NAME,
			),
		),
		generic_file_upload_max_bytes: parseIntMin(
			envOr(
				activeEnv,
				"GENERIC_FILE_UPLOAD_MAX_BYTES",
				CONFIG.GENERIC_FILE_UPLOAD_MAX_BYTES,
			),
			CONFIG.GENERIC_FILE_UPLOAD_MAX_BYTES,
			0,
		),
		api_keys: parseApiKeys(envOr(activeEnv, "API_KEYS", CONFIG.API_KEYS)),
		admin_keys: parseAdminKeys(
			envOr(activeEnv, "ADMIN_KEYS", CONFIG.ADMIN_KEYS),
			envOr(activeEnv, "ADMIN_KEY", CONFIG.ADMIN_KEY),
		),
		cookie: "",
		sapisid: "",
	};
	_configCacheKey = cacheKey;
	_configCacheValue = cfg;
	_configCacheEnv = activeEnv;
	_configCacheByEnv.set(activeEnv, { key: cacheKey, value: cfg });
	return cfg;
}
