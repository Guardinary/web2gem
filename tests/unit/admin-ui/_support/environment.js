import { withPatchedGlobal } from "../../_support/globals.js";

export function withAdminFetch(fetchImpl, run) {
	return withPatchedGlobal("fetch", fetchImpl, run);
}

export function withAdminWindow(run, overrides = {}) {
	return withPatchedGlobal(
		"window",
		{ setTimeout: () => 0, ...overrides },
		run,
	);
}

export function withAdminEnvironment(fetchImpl, run) {
	return withAdminWindow(() => withAdminFetch(fetchImpl, run));
}

export function createMemoryStorage(initial = {}) {
	const entries = new Map(
		Object.entries(initial).map(([key, value]) => [key, String(value)]),
	);
	return {
		getItem(key) {
			return entries.get(String(key)) ?? null;
		},
		setItem(key, value) {
			entries.set(String(key), String(value));
		},
		removeItem(key) {
			entries.delete(String(key));
		},
	};
}
