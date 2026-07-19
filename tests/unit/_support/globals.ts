type AsyncRun<T> = () => T | PromiseLike<T>;

export async function withPatchedGlobal<T>(
	name: string,
	value: unknown,
	run: AsyncRun<T>,
): Promise<T> {
	const target = globalThis as unknown as Record<string, unknown>;
	const original = Object.getOwnPropertyDescriptor(target, name);
	Object.defineProperty(target, name, {
		value,
		configurable: true,
		writable: true,
	});
	try {
		return await run();
	} finally {
		if (original) Object.defineProperty(target, name, original);
		else delete target[name];
	}
}

export async function withFetch<T>(fn: unknown, run: AsyncRun<T>): Promise<T> {
	return withPatchedGlobal("fetch", fn, run);
}

async function withConsoleMethod<T>(
	method: keyof Console & string,
	fn: unknown,
	run: AsyncRun<T>,
): Promise<T> {
	const activeConsole = console as unknown as Record<string, unknown>;
	const original = Object.getOwnPropertyDescriptor(activeConsole, method);
	Object.defineProperty(activeConsole, method, {
		value: fn,
		configurable: true,
		writable: true,
	});
	try {
		return await run();
	} finally {
		if (original) Object.defineProperty(activeConsole, method, original);
		else delete activeConsole[method];
	}
}

export async function withConsoleLog<T>(
	fn: unknown,
	run: AsyncRun<T>,
): Promise<T> {
	return withConsoleMethod("log", fn, run);
}
