export interface Deferred<T = unknown> {
	promise: Promise<T | undefined>;
	readonly settled: boolean;
	resolve(value?: T): void;
	reject(error?: unknown): void;
}

export function deferred<T = unknown>(): Deferred<T> {
	let settle: (value: T | undefined) => void = () => undefined;
	let fail: (error?: unknown) => void = () => undefined;
	let settled = false;
	const promise = new Promise<T | undefined>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	return {
		promise,
		get settled() {
			return settled;
		},
		resolve(value?: T) {
			if (settled) return;
			settled = true;
			settle(value);
		},
		reject(error?: unknown) {
			if (settled) return;
			settled = true;
			fail(error);
		},
	};
}
