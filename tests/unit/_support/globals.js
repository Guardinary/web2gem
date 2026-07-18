export async function withPatchedGlobal(name, value, run) {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, {
		value,
		configurable: true,
		writable: true,
	});
	try {
		return await run();
	} finally {
		if (original) Object.defineProperty(globalThis, name, original);
		else delete globalThis[name];
	}
}

export async function withFetch(fn, run) {
	return withPatchedGlobal("fetch", fn, run);
}

async function withConsoleMethod(method, fn, run) {
	const activeConsole = Reflect.get(globalThis, "console");
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

export async function withConsoleLog(fn, run) {
	return withConsoleMethod("log", fn, run);
}
