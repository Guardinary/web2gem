import http from "node:http";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createD1HttpBindingFromEnv } from "./d1-http-binding.mjs";
import { errorLine, outputLine } from "./io.mjs";

const port = Number(process.env.PORT || 52389);
const host = process.env.HOST || "0.0.0.0";
const env = { ...process.env };
let defaultWorkerModulePromise = null;
let defaultResolvedEnv = null;

export function requestHeaders(rawHeaders) {
	const headers = new Headers();
	for (let i = 0; i < rawHeaders.length; i += 2) {
		const name = rawHeaders[i];
		const value = rawHeaders[i + 1];
		if (name && value !== undefined) headers.append(name, value);
	}
	return headers;
}

export function requestUrl(req, fallbackPort = port) {
	const scheme =
		firstForwardedHeaderValue(req.headers["x-forwarded-proto"]) || "http";
	const forwardedHost = firstForwardedHeaderValue(
		req.headers["x-forwarded-host"],
	);
	const authority =
		forwardedHost ||
		firstForwardedHeaderValue(req.headers.host) ||
		`localhost:${fallbackPort}`;
	return `${scheme}://${authority}${req.url || "/"}`;
}

function firstForwardedHeaderValue(value) {
	const raw = Array.isArray(value) ? value[0] : value;
	return String(raw || "")
		.split(",")[0]
		.trim();
}

export function executionContext() {
	const pending = new Set();
	return {
		runtimeProfile: "docker",
		waitUntil(promise) {
			const p = Promise.resolve(promise).catch((err) => {
				errorLine("waitUntil failed:", err);
			});
			pending.add(p);
			p.finally(() => pending.delete(p));
		},
		passThroughOnException() {},
	};
}

export function resolveDockerEnv(sourceEnv = process.env, options = {}) {
	const nextEnv = { ...sourceEnv };
	const d1Binding = createD1HttpBindingFromEnv(sourceEnv, {
		fetch: options.fetch,
	});
	if (d1Binding) nextEnv.GEMINI_DB = d1Binding;
	return nextEnv;
}

export async function handleDockerRequest(req, res, options = {}) {
	const workerImpl = options.worker || (await defaultWorker());
	const requestEnv = options.env || defaultDockerEnv();
	const fallbackPort = Number(options.port || port);
	const method = req.method || "GET";
	const abortController = new AbortController();
	const abortRequest = () => {
		if (!abortController.signal.aborted)
			abortController.abort(new Error("docker client disconnected"));
	};
	const abortOnResponseClose = () => {
		if (!res.writableEnded) abortRequest();
	};
	req.once("aborted", abortRequest);
	res.once("close", abortOnResponseClose);
	if (req.aborted) abortRequest();
	const init = {
		method,
		headers: requestHeaders(req.rawHeaders),
		signal: abortController.signal,
	};

	if (method !== "GET" && method !== "HEAD") {
		init.body = Readable.toWeb(req);
		init.duplex = "half";
	}

	try {
		const request = new Request(requestUrl(req, fallbackPort), init);
		const response = await workerImpl.fetch(
			request,
			requestEnv,
			executionContext(),
		);

		res.statusCode = response.status;
		response.headers.forEach((value, key) => {
			res.setHeader(key, value);
		});

		if (!response.body || method === "HEAD") {
			res.end();
			return;
		}

		const body = Readable.fromWeb(response.body);
		body.pipe(res);
		await finished(res);
	} catch (error) {
		if (abortController.signal.aborted) return;
		throw error;
	} finally {
		req.off("aborted", abortRequest);
		res.off("close", abortOnResponseClose);
	}
}

function defaultDockerEnv() {
	if (!defaultResolvedEnv) defaultResolvedEnv = resolveDockerEnv(env);
	return defaultResolvedEnv;
}

async function defaultWorker() {
	const mod = await defaultWorkerModule();
	return mod.default || mod;
}

async function defaultWorkerModule() {
	if (!defaultWorkerModulePromise)
		defaultWorkerModulePromise = import("../dist/worker.js");
	return defaultWorkerModulePromise;
}

export function createDockerServer(options = {}) {
	const serverOptions = options.env
		? options
		: {
				...options,
				env: resolveDockerEnv(options.processEnv || process.env, {
					fetch: options.fetch,
				}),
			};
	return http.createServer((req, res) => {
		handleDockerRequest(req, res, serverOptions).catch((err) => {
			errorLine("request failed:", err);
			if (!res.headersSent) {
				res.statusCode = 500;
				res.setHeader("content-type", "application/json; charset=utf-8");
			}
			res.end(JSON.stringify({ error: { message: "internal server error" } }));
		});
	});
}

export async function startDockerServer(options = {}) {
	const resolvedEnv =
		options.env ||
		resolveDockerEnv(options.processEnv || process.env, {
			fetch: options.fetch,
		});
	let worker = options.worker;
	if (!worker) {
		const mod = await defaultWorkerModule();
		if (typeof mod.assertRuntimeConfig !== "function")
			throw new Error("worker bundle is missing assertRuntimeConfig");
		mod.assertRuntimeConfig(resolvedEnv);
		worker = mod.default || mod;
	}
	const server = createDockerServer({ ...options, env: resolvedEnv, worker });
	const listenPort = Number(options.port || port);
	const listenHost = options.host || host;
	server.listen(listenPort, listenHost, () => {
		outputLine(`web2gem listening on http://${listenHost}:${listenPort}`);
	});
	return server;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await startDockerServer();
}
