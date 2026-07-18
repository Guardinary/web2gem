import { withPatchedGlobal } from "../../helpers.js";

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

export function deferred() {
	let settle;
	let fail;
	let settled = false;
	const promise = new Promise((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	return {
		promise,
		get settled() {
			return settled;
		},
		resolve(value) {
			if (settled) return;
			settled = true;
			settle(value);
		},
		reject(error) {
			if (settled) return;
			settled = true;
			fail(error);
		},
	};
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
