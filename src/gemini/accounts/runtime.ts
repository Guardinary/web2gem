import type { RuntimeConfig, WorkerEnv } from "../../config";
import type { GeminiModelCatalog, ResolvedModel } from "../../models";
import { rotateGeminiAccountCookie } from "./cookie-rotator";
import type { GeminiModelRoutingOverview } from "./admin-types";
import type { GeminiAccountLease } from "./lease-types";
import { AccountPoolService } from "./pool";
import type { GeminiRouteTuple } from "./route-types";
import { verifyGeminiAccount } from "./probe";
import type {
	GeminiAccountAcquireOptions,
	GeminiAccountRuntimeOptions,
} from "./runtime-types";
import { D1GeminiAccountStore } from "./store-d1";
import type { D1DatabaseLike } from "./storage-types";

const DEFAULT_RUNTIME_BY_DB = new WeakMap<
	D1DatabaseLike,
	GeminiAccountRuntime
>();

export class GeminiAccountRuntime {
	constructor(readonly pool: AccountPoolService) {}

	acquireLease(
		baseConfig: RuntimeConfig,
		options: GeminiAccountAcquireOptions = {},
	): Promise<GeminiAccountLease | null> {
		return this.pool.acquireLease(baseConfig, options);
	}

	modelCatalog(capabilityFreshAfterMs: number): Promise<GeminiModelCatalog> {
		return this.pool.modelCatalog(capabilityFreshAfterMs);
	}

	modelRoutingOverview(
		capabilityFreshAfterMs: number,
	): Promise<GeminiModelRoutingOverview> {
		return this.pool.modelRoutingOverview(capabilityFreshAfterMs);
	}

	resolveModel(
		modelName: unknown,
		defaultName: unknown,
		capabilityFreshAfterMs: number,
	): Promise<ResolvedModel> {
		return this.pool.resolveModel(
			modelName,
			defaultName,
			capabilityFreshAfterMs,
		);
	}

	routeCandidatesForModel(
		model: Extract<ResolvedModel, { name: string }>,
		capabilityFreshAfterMs: number,
	): Promise<GeminiRouteTuple[]> {
		return this.pool.routeCandidatesForModel(model, capabilityFreshAfterMs);
	}
}

function createGeminiAccountRuntimeFromEnv(
	env: WorkerEnv | null | undefined,
	options: GeminiAccountRuntimeOptions = {},
): GeminiAccountRuntime | null {
	const db = d1BindingFromEnv(env);
	if (!db) return null;
	const rotateCookie = options.rotateCookie || rotateGeminiAccountCookie;
	const verifyAccount = options.verifyAccount || verifyGeminiAccount;
	return new GeminiAccountRuntime(
		new AccountPoolService(new D1GeminiAccountStore(db), {
			...options,
			rotateCookie,
			verifyAccount,
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
