import type { RuntimeConfig, WorkerEnv } from "../../config";
import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import { AccountPoolService } from "./pool";
import { D1GeminiAccountStore } from "./store-d1";
import type {
	D1DatabaseLike,
	GeminiAccountLease,
	GeminiAccountRotateResponse,
	GeminiAccountRuntimeOptions,
	GeminiAccountSecretRow,
} from "./types";

const DEFAULT_RUNTIME_BY_DB = new WeakMap<
	D1DatabaseLike,
	GeminiAccountRuntime
>();

export class GeminiAccountRuntime {
	constructor(readonly pool: AccountPoolService) {}

	acquireLease(baseConfig: RuntimeConfig): Promise<GeminiAccountLease | null> {
		return this.pool.acquireLease(baseConfig);
	}
}

export function createGeminiAccountRuntimeFromEnv(
	env: WorkerEnv | null | undefined,
	options: GeminiAccountRuntimeOptions = {},
): GeminiAccountRuntime | null {
	const db = d1BindingFromEnv(env);
	if (!db) return null;
	const rotateCookie = options.rotateCookie || defaultRotateCookie;
	return new GeminiAccountRuntime(
		new AccountPoolService(new D1GeminiAccountStore(db), {
			...options,
			rotateCookie,
		}),
	);
}

export function getGeminiAccountRuntimeFromEnv(
	env: WorkerEnv | null | undefined,
): GeminiAccountRuntime | null {
	const db = d1BindingFromEnv(env);
	if (!db) return null;
	const existing = DEFAULT_RUNTIME_BY_DB.get(db);
	if (existing) return existing;
	const runtime = createGeminiAccountRuntimeFromEnv(env);
	if (!runtime) return null;
	DEFAULT_RUNTIME_BY_DB.set(db, runtime);
	return runtime;
}

export function d1BindingFromEnv(
	env: WorkerEnv | null | undefined,
): D1DatabaseLike | null {
	const binding = env?.GEMINI_DB;
	if (!isD1DatabaseLike(binding)) return null;
	return binding;
}

function isD1DatabaseLike(value: unknown): value is D1DatabaseLike {
	if (!value || typeof value !== "object") return false;
	return typeof (value as Partial<D1DatabaseLike>).prepare === "function";
}

async function defaultRotateCookie(input: {
	config: RuntimeConfig;
	account: GeminiAccountSecretRow;
}): Promise<GeminiAccountRotateResponse> {
	return httpFetch("https://accounts.google.com/RotateCookies", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: "https://accounts.google.com",
			Referer: "https://accounts.google.com/",
			"User-Agent": input.account.user_agent || GEMINI_WEB_USER_AGENT,
			"Accept-Language": "en-US,en;q=0.9",
			Cookie: input.account.cookie_header,
		},
		body: '[000,"-0000000000000000000"]',
		timeoutMs: Math.min(
			Math.max(Number(input.config.request_timeout_sec) || 30, 1) * 1000,
			30000,
		),
		socket: input.config.upstream_socket,
		socketFallback: "never",
		cfg: input.config,
	});
}
