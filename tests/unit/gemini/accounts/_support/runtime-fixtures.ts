import type {
	GeminiAccountRuntimeContext,
	RuntimeConfig,
} from "../../../../../src/config/types.js";
import { AccountPoolService } from "../../../../../src/gemini/accounts/pool.js";
import type { GeminiAccountCapabilityRow } from "../../../../../src/gemini/accounts/route-types.js";
import type { GeminiAccountRuntimeStore } from "../../../../../src/gemini/accounts/runtime-types.js";
import type { GeminiAccountRow } from "../../../../../src/gemini/accounts/storage-types.js";
import type {
	ResolvedModel,
	ResolvedModelOk,
} from "../../../../../src/models/index.js";
import { assert } from "../../../assertions.js";

export function account(
	id: string,
	overrides: Partial<GeminiAccountRow> = {},
): GeminiAccountRow {
	return {
		id,
		label: null,
		enabled: 1,
		cookie_header: `__Secure-1PSID=p-${id}; __Secure-1PSIDTS=t-${id}`,
		cookie_hash: `hash-${id}`,
		identity_hash: `identity-${id}`,
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
		account_status_code: null,
		status_checked_at_ms: null,
		last_refresh_attempt_at_ms: null,
		last_refresh_success_at_ms: null,
		created_at_ms: 1000,
		updated_at_ms: 1000,
		...overrides,
	};
}

export function capabilityRow(
	accountId: string,
	modelId: string,
	capacity: number,
	capacityField: number,
	modelNumber: number,
	discoveryOrder: number,
	checkedAtMs: number,
	overrides: Partial<GeminiAccountCapabilityRow> = {},
): GeminiAccountCapabilityRow {
	return {
		account_id: accountId,
		model_id: modelId,
		display_name: modelId,
		description: `${modelId} description`,
		available: 1,
		capacity,
		capacity_field: capacityField,
		model_number: modelNumber,
		discovery_order: discoveryOrder,
		checked_at_ms: checkedAtMs,
		...overrides,
	};
}

type RuntimeMethod = keyof GeminiAccountRuntimeStore;
type RuntimeFunction<M extends RuntimeMethod> = NonNullable<
	GeminiAccountRuntimeStore[M]
>;
type RuntimeArguments<M extends RuntimeMethod> = Parameters<RuntimeFunction<M>>;
type RuntimeResult<M extends RuntimeMethod> = Awaited<
	ReturnType<RuntimeFunction<M>>
>;
type RuntimeCallFor<M extends RuntimeMethod> = {
	method: M;
	args: RuntimeArguments<M> | ((args: RuntimeArguments<M>) => void);
	result: RuntimeResult<M>;
};
export type RuntimeCall = {
	[M in RuntimeMethod]: RuntimeCallFor<M>;
}[RuntimeMethod];

const REQUIRED_RUNTIME_METHODS = [
	"getPoolVersion",
	"listSelectableAccounts",
	"getAccountForRefresh",
	"tryAcquireRefreshLock",
	"releaseRefreshLock",
	"writeRefreshedCookie",
	"writeAccountOutcome",
] as const satisfies readonly RuntimeMethod[];

const OPTIONAL_RUNTIME_METHODS = [
	"writeAccountProbe",
	"listAccountCapabilities",
	"listAllAccountCapabilities",
	"listModelRoutePriorities",
	"replaceModelRoutePriority",
	"clearModelRoutePriority",
] as const satisfies readonly RuntimeMethod[];

const RUNTIME_METHODS = new Set<RuntimeMethod>([
	...REQUIRED_RUNTIME_METHODS,
	...OPTIONAL_RUNTIME_METHODS,
]);

export function runtimeCall<M extends RuntimeMethod>(
	method: M,
	args: RuntimeArguments<M> | ((args: RuntimeArguments<M>) => void),
	result: RuntimeResult<M>,
): RuntimeCallFor<M> {
	return { method, args, result };
}

type RuntimeStoreFixture = GeminiAccountRuntimeStore & {
	readonly calls: readonly {
		method: RuntimeMethod;
		args: readonly unknown[];
	}[];
	callsFor(method: RuntimeMethod): readonly (readonly unknown[])[];
	assertExhausted(): void;
};

export function createRuntimeStore(
	script: readonly RuntimeCall[],
): RuntimeStoreFixture {
	if (!Array.isArray(script))
		throw new Error("Runtime store script must be an ordered array");
	const remaining = script.map((step, index) => {
		if (!step || typeof step !== "object")
			throw new Error(`Invalid runtime store step at index ${index}`);
		if (!RUNTIME_METHODS.has(step.method))
			throw new Error(`Unknown runtime store method: ${step.method}`);
		if (!Array.isArray(step.args) && typeof step.args !== "function")
			throw new Error(
				`Runtime store step must declare exact args: ${step.method}`,
			);
		return step;
	});
	const scriptedMethods = new Set(remaining.map((step) => step.method));
	const calls: { method: RuntimeMethod; args: readonly unknown[] }[] = [];

	async function invoke<M extends RuntimeMethod>(
		method: M,
		args: RuntimeArguments<M>,
	): Promise<RuntimeResult<M>> {
		calls.push({ method, args });
		const step = remaining.shift();
		if (!step) throw new Error(`Unexpected runtime store call: ${method}`);
		if (step.method !== method)
			throw new Error(
				`Unexpected runtime store call: expected ${step.method}, received ${method}`,
			);
		// The checked discriminator correlates this union member with M.
		const matchingStep = step as RuntimeCallFor<M>;
		if (typeof matchingStep.args === "function") matchingStep.args(args);
		else
			assert.deepEqual(args, matchingStep.args, `runtime store ${method} args`);
		return matchingStep.result;
	}

	const fixture = {
		calls,
		callsFor(method: RuntimeMethod) {
			return calls
				.filter((call) => call.method === method)
				.map((call) => call.args);
		},
		assertExhausted() {
			if (remaining.length)
				throw new Error(
					`Unused runtime store script: ${remaining
						.map((step) => step.method)
						.join(" -> ")}`,
				);
		},
		getPoolVersion: (...args: RuntimeArguments<"getPoolVersion">) =>
			invoke("getPoolVersion", args),
		listSelectableAccounts: (
			...args: RuntimeArguments<"listSelectableAccounts">
		) => invoke("listSelectableAccounts", args),
		getAccountForRefresh: (...args: RuntimeArguments<"getAccountForRefresh">) =>
			invoke("getAccountForRefresh", args),
		tryAcquireRefreshLock: (
			...args: RuntimeArguments<"tryAcquireRefreshLock">
		) => invoke("tryAcquireRefreshLock", args),
		releaseRefreshLock: (...args: RuntimeArguments<"releaseRefreshLock">) =>
			invoke("releaseRefreshLock", args),
		writeRefreshedCookie: (...args: RuntimeArguments<"writeRefreshedCookie">) =>
			invoke("writeRefreshedCookie", args),
		writeAccountOutcome: (...args: RuntimeArguments<"writeAccountOutcome">) =>
			invoke("writeAccountOutcome", args),
		...(scriptedMethods.has("writeAccountProbe")
			? {
					writeAccountProbe: (...args: RuntimeArguments<"writeAccountProbe">) =>
						invoke("writeAccountProbe", args),
				}
			: {}),
		...(scriptedMethods.has("listAccountCapabilities")
			? {
					listAccountCapabilities: (
						...args: RuntimeArguments<"listAccountCapabilities">
					) => invoke("listAccountCapabilities", args),
				}
			: {}),
		...(scriptedMethods.has("listAllAccountCapabilities")
			? {
					listAllAccountCapabilities: (
						...args: RuntimeArguments<"listAllAccountCapabilities">
					) => invoke("listAllAccountCapabilities", args),
				}
			: {}),
		...(scriptedMethods.has("listModelRoutePriorities")
			? {
					listModelRoutePriorities: (
						...args: RuntimeArguments<"listModelRoutePriorities">
					) => invoke("listModelRoutePriorities", args),
				}
			: {}),
		...(scriptedMethods.has("replaceModelRoutePriority")
			? {
					replaceModelRoutePriority: (
						...args: RuntimeArguments<"replaceModelRoutePriority">
					) => invoke("replaceModelRoutePriority", args),
				}
			: {}),
		...(scriptedMethods.has("clearModelRoutePriority")
			? {
					clearModelRoutePriority: (
						...args: RuntimeArguments<"clearModelRoutePriority">
					) => invoke("clearModelRoutePriority", args),
				}
			: {}),
	} satisfies RuntimeStoreFixture;

	return fixture;
}

export function runtimeConfig(
	overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
	return {
		gemini_bl: "boq_assistant-bard-web-server_20260701.00_p0",
		gemini_origin: "https://gemini.google.com",
		upstream_socket: false,
		default_model: "gemini-3.5-flash",
		retry_attempts: 2,
		gemini_account_max_attempts: 10,
		gemini_account_refresh_interval_sec: 600,
		gemini_account_capability_ttl_sec: 3600,
		gemini_account_capability_mode: "prefer",
		retry_delay_sec: 1,
		request_timeout_sec: 60,
		request_body_max_bytes: 16 * 1024 * 1024,
		log_requests: false,
		current_input_file_enabled: false,
		current_input_file_min_bytes: 1_000_000,
		current_input_file_name: "message.txt",
		current_tools_file_name: "tools.txt",
		generic_file_upload_max_bytes: 20 * 1024 * 1024,
		api_keys: [],
		admin_key: "test-admin-key",
		cookie: "",
		sapisid: "",
		...overrides,
	};
}

export function required<T>(value: T | null | undefined, label: string): T {
	if (value == null) throw new Error(`${label} is required`);
	return value;
}

export function accountContext(
	config: RuntimeConfig,
): GeminiAccountRuntimeContext {
	return required(config.gemini_account, "Gemini account runtime context");
}

export function resolvedModel(value: ResolvedModel): ResolvedModelOk {
	if (value.error !== undefined)
		throw new Error(`Model resolution failed: ${value.error}`);
	return value;
}

export async function rejectUnexpectedCookieRotation(): Promise<never> {
	throw new Error("Unexpected Gemini account cookie rotation");
}

type PoolOverrides = Partial<
	Omit<
		ConstructorParameters<typeof AccountPoolService>[1],
		"nowMs" | "rotateCookie" | "verifyAccount"
	>
>;

export function createPool(
	store: GeminiAccountRuntimeStore,
	nowMs: number,
	overrides: PoolOverrides = {},
): AccountPoolService {
	return new AccountPoolService(store, {
		...overrides,
		nowMs: () => nowMs,
		rotateCookie: rejectUnexpectedCookieRotation,
	});
}
