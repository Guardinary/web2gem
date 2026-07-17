import {
	captureConfigSnapshot,
	CONFIG_ENV_KEYS,
	configSnapshotMatches,
	parseStaticRuntimeConfig,
	type ConfigCacheSnapshot,
} from "./spec";
import type {
	GeminiAccountSessionContext,
	RuntimeConfig,
	RuntimeExecutionContext,
	StaticRuntimeConfig,
	WorkerEnv,
} from "./types";

export const VERSION = "2.0.0-worker";

export type {
	GeminiAccountRuntimeContext,
	GeminiAccountSessionContext,
	RuntimeConfig,
	RuntimeExecutionContext,
	RuntimeProfile,
	StaticRuntimeConfig,
	WorkerEnv,
} from "./types";
export { RuntimeConfigError } from "./parse";
export { CONFIG_ENV_KEYS };

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

const DEFAULT_ENV: WorkerEnv = {};
type ConfigCacheEntry = {
	snapshot: ConfigCacheSnapshot;
	value: StaticRuntimeConfig;
};
const CONFIG_CACHE = new WeakMap<WorkerEnv, ConfigCacheEntry>();

export function getConfig(env: WorkerEnv = DEFAULT_ENV): StaticRuntimeConfig {
	const activeEnv = env || DEFAULT_ENV;
	const cached = CONFIG_CACHE.get(activeEnv);
	if (cached && configSnapshotMatches(cached.snapshot, activeEnv))
		return cached.value;
	const value = parseStaticRuntimeConfig(activeEnv);
	CONFIG_CACHE.set(activeEnv, {
		snapshot: captureConfigSnapshot(activeEnv),
		value,
	});
	return value;
}

export function assertRuntimeConfig(env: WorkerEnv = DEFAULT_ENV): void {
	void getConfig(env);
}
