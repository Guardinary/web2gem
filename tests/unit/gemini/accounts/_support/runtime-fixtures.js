import { assert } from "../../../assertions.js";

export function account(id, overrides = {}) {
	return {
		id,
		label: null,
		enabled: 1,
		cookie_header: `__Secure-1PSID=p-${id}; __Secure-1PSIDTS=t-${id}`,
		cookie_hash: `hash-${id}`,
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
		status_checked_at_ms: null,
		last_refresh_success_at_ms: null,
		created_at_ms: 1000,
		updated_at_ms: 1000,
		...overrides,
	};
}

export function capabilityRow(
	accountId,
	modelId,
	capacity,
	capacityField,
	modelNumber,
	discoveryOrder,
	checkedAtMs,
	overrides = {},
) {
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

const REQUIRED_RUNTIME_METHODS = [
	"getPoolVersion",
	"listSelectableAccounts",
	"getAccountForRefresh",
	"tryAcquireRefreshLock",
	"releaseRefreshLock",
	"writeRefreshedCookie",
	"writeAccountOutcome",
];

const OPTIONAL_RUNTIME_METHODS = [
	"writeAccountProbe",
	"listAccountCapabilities",
	"listAllAccountCapabilities",
	"listModelRoutePriorities",
	"replaceModelRoutePriority",
	"clearModelRoutePriority",
];

const RUNTIME_METHODS = new Set([
	...REQUIRED_RUNTIME_METHODS,
	...OPTIONAL_RUNTIME_METHODS,
]);

export function runtimeCall(method, args, result) {
	return { method, args, result };
}

export function createRuntimeStore(script) {
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

	const calls = [];
	const store = {
		calls,
		callsFor(method) {
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
	};

	async function invoke(method, args) {
		calls.push({ method, args });
		const step = remaining.shift();
		if (!step) throw new Error(`Unexpected runtime store call: ${method}`);
		if (step.method !== method)
			throw new Error(
				`Unexpected runtime store call: expected ${step.method}, received ${method}`,
			);
		if (typeof step.args === "function") step.args(args);
		else assert.deepEqual(args, step.args, `runtime store ${method} args`);
		return step.result;
	}

	for (const method of REQUIRED_RUNTIME_METHODS)
		store[method] = (...args) => invoke(method, args);
	for (const method of OPTIONAL_RUNTIME_METHODS) {
		if (scriptedMethods.has(method))
			store[method] = (...args) => invoke(method, args);
	}
	return store;
}

export async function rejectUnexpectedCookieRotation() {
	throw new Error("Unexpected Gemini account cookie rotation");
}
