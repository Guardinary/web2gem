import { withPatchedGlobal } from "../../_support/globals.js";

type AsyncRun<T> = () => T | PromiseLike<T>;

export function withAdminFetch<T>(
	fetchImpl: unknown,
	run: AsyncRun<T>,
): Promise<T> {
	return withPatchedGlobal("fetch", fetchImpl, run);
}

export function withAdminWindow<T>(
	run: AsyncRun<T>,
	overrides: Record<string, unknown> = {},
): Promise<T> {
	return withPatchedGlobal(
		"window",
		{ setTimeout: () => 0, ...overrides },
		run,
	);
}

export function withAdminEnvironment<T>(
	fetchImpl: unknown,
	run: AsyncRun<T>,
): Promise<T> {
	return withAdminWindow(() => withAdminFetch(fetchImpl, run));
}

export function createMemoryStorage(initial: Record<string, unknown> = {}) {
	const entries = new Map(
		Object.entries(initial).map(([key, value]) => [key, String(value)]),
	);
	return {
		getItem(key: string) {
			return entries.get(String(key)) ?? null;
		},
		setItem(key: string, value: string) {
			entries.set(String(key), String(value));
		},
		removeItem(key: string) {
			entries.delete(String(key));
		},
	};
}
