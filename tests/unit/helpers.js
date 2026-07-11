import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const testBundle = process.env.TEST_BUNDLE || "../../dist/worker.test.js";
export const mod = await importTestBundle(testBundle);

async function importTestBundle(bundle) {
	if (bundle === "../../dist/worker.test.js")
		return import(workspaceFileUrl("dist/worker.test.js"));
	if (bundle === "../../dist-coverage/worker.test.js")
		return import(workspaceFileUrl("dist-coverage/worker.test.js"));
	return import(new URL(bundle, import.meta.url).href);
}

function workspaceFileUrl(path) {
	return pathToFileURL(resolve(process.cwd(), path)).href;
}

export async function* chunks(items, throwAfter = null) {
	for (let i = 0; i < items.length; i++) {
		yield items[i];
		if (throwAfter === i) throw new Error("stream broke");
	}
}

export function fakeStreamProvider(items) {
	return {
		async generateText() {
			return items.join("");
		},
		streamText() {
			return chunks(items);
		},
		async resolveAttachments() {
			return attachmentResult();
		},
		async uploadTextFile(_text, filename) {
			return { ref: `/uploaded/${filename}`, name: filename };
		},
	};
}

export function fakeProvider(overrides = {}) {
	return {
		supportsAuthenticatedSession: true,
		async generateText() {
			return "";
		},
		streamText() {
			return chunks([]);
		},
		async resolveAttachments() {
			return attachmentResult();
		},
		async uploadTextFile(_text, filename) {
			return { ref: `/uploaded/${filename}`, name: filename };
		},
		...overrides,
	};
}

export function attachmentResult(overrides = {}) {
	return {
		fileRefs: overrides.fileRefs ?? null,
		imageFileRefs: overrides.imageFileRefs ?? null,
		genericFileRefs: overrides.genericFileRefs ?? null,
		promptText: overrides.promptText || "",
		droppedNote: overrides.droppedNote || "",
		supportsFileRefs: overrides.supportsFileRefs ?? true,
		usage: overrides.usage || {
			uploadedFiles: overrides.fileRefs ? overrides.fileRefs.length : 0,
			dedupedFiles: 0,
			uploadedBytes: 0,
			fileRefBytes: 0,
			inlinedFiles: overrides.promptText ? 1 : 0,
			inlinedBytes: 0,
			droppedFiles: overrides.droppedNote ? 1 : 0,
			multipartUploads: 0,
		},
	};
}

export function baseConfig(overrides = {}) {
	return {
		default_model: "gemini-3.5-flash",
		current_input_file_enabled: false,
		current_input_file_min_bytes: 1000000,
		current_input_file_name: "message.txt",
		current_tools_file_name: "tools.txt",
		generic_file_upload_max_bytes: 20 * 1024 * 1024,
		request_body_max_bytes: 16 * 1024 * 1024,
		cookie: "",
		log_requests: false,
		...overrides,
	};
}

export function resolvedModel(name = "gemini-3.5-flash") {
	return { name };
}

export function streamError(message = "stream broke", code = "stream_broke") {
	const err = new Error(message);
	err.code = code;
	return err;
}

export function collectSSEData(writes) {
	return writes
		.join("")
		.split("\n\n")
		.filter(Boolean)
		.map((frame) => {
			const dataLine = frame
				.split("\n")
				.find((line) => line.startsWith("data: "));
			if (!dataLine) return null;
			const data = dataLine.slice("data: ".length);
			return data === "[DONE]" ? data : JSON.parse(data);
		})
		.filter((item) => item !== null);
}

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

export async function withCaches(cache, run) {
	return withPatchedGlobal("caches", { default: cache }, run);
}

export function createMemoryCache() {
	const store = new Map();
	const stats = { match: 0, put: 0, delete: 0 };
	return {
		stats,
		async match(request) {
			stats.match += 1;
			const response = store.get(request.url);
			return response ? response.clone() : undefined;
		},
		async put(request, response) {
			stats.put += 1;
			store.set(request.url, response.clone());
		},
		async delete(request) {
			stats.delete += 1;
			return store.delete(request.url);
		},
	};
}

export async function withConsoleLog(fn, run) {
	const activeConsole = Reflect.get(globalThis, "console");
	const original = activeConsole.log;
	activeConsole.log = fn;
	try {
		return await run();
	} finally {
		activeConsole.log = original;
	}
}

export function resetTestState() {
	if (typeof mod.resetActiveGeminiCookieForTest === "function")
		mod.resetActiveGeminiCookieForTest();
	if (typeof mod.resetGeminiBuildLabelCacheForTest === "function")
		mod.resetGeminiBuildLabelCacheForTest();
	if (typeof mod.resetGeminiUploadCachesForTest === "function")
		mod.resetGeminiUploadCachesForTest();
	if (typeof mod._setConnectForTest === "function")
		mod._setConnectForTest(null);
}

export function fakeSocketConnect(responseChunks, state = {}) {
	const encoder = new TextEncoder();
	const writes = [];
	state.writes = writes;
	state.closed = false;
	return function connect() {
		return {
			readable: new ReadableStream({
				start(controller) {
					for (const chunk of responseChunks) {
						controller.enqueue(
							typeof chunk === "string" ? encoder.encode(chunk) : chunk,
						);
					}
					controller.close();
				},
			}),
			writable: new WritableStream({
				write(chunk) {
					writes.push(chunk);
				},
			}),
			close() {
				state.closed = true;
			},
		};
	};
}

export function fakePersistentSocketConnect(
	responseChunksByRequest,
	state = {},
) {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const writes = [];
	state.writes = writes;
	state.connects = 0;
	state.closed = 0;
	let responseIndex = 0;
	return function connect() {
		state.connects += 1;
		let controller;
		let requestText = "";
		return {
			readable: new ReadableStream({
				start(c) {
					controller = c;
				},
			}),
			writable: new WritableStream({
				write(chunk) {
					writes.push(chunk);
					requestText += decoder.decode(chunk, { stream: true });
					if (!requestText.includes("\r\n\r\n")) return;
					const responseChunks = responseChunksByRequest[responseIndex++] || [];
					requestText = "";
					for (const part of responseChunks) {
						controller.enqueue(
							typeof part === "string" ? encoder.encode(part) : part,
						);
					}
				},
			}),
			close() {
				state.closed += 1;
				try {
					controller.close();
				} catch (_) {}
			},
		};
	};
}

export function joinedWriteText(state) {
	const total = state.writes.reduce((sum, chunk) => sum + chunk.length, 0);
	return new TextDecoder().decode(mod._joinByteChunks(state.writes, total));
}
