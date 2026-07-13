import type { RuntimeConfig, WorkerEnv } from "../../config";
import { rotateGeminiAccountCookie } from "./cookie-rotator";
import { AccountPoolService } from "./pool";
import { D1GeminiAccountStore } from "./store-d1";
import type {
	D1DatabaseLike,
	GeminiAccountLease,
	GeminiAccountRuntimeOptions,
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
	const rotateCookie = options.rotateCookie || rotateGeminiAccountCookie;
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
