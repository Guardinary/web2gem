import type { Server } from "node:http";
import { describe, test } from "vitest";
import { assertRuntimeConfig } from "../../src/config";
import worker from "../../src/index";
import { isRecord, type UnknownRecord } from "../../src/shared/types";
import { assert } from "./assertions.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type DockerExecutionContext = {
	runtimeProfile: "docker";
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
};
type DockerRequest = {
	headers: Record<string, string | readonly string[] | undefined>;
	url?: string | null;
};
type DockerServerOptions = {
	host?: string;
	port?: number;
	env?: Record<string, unknown>;
	processEnv?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	worker?: DockerWorker;
};
type DockerWorker = {
	fetch(
		request: Request,
		env: Record<string, unknown>,
		context: DockerExecutionContext,
	): Response | Promise<Response>;
	assertRuntimeConfig?: (env: Record<string, unknown>) => void;
};
type D1HttpResult = {
	results: UnknownRecord[];
	success: boolean;
	meta: UnknownRecord;
};
type D1HttpStatement = {
	bind(...values: unknown[]): D1HttpStatement;
	first(columnName?: string): Promise<unknown>;
	all(): Promise<D1HttpResult>;
	run(): Promise<Omit<D1HttpResult, "results">>;
};
type D1HttpBinding = {
	prepare(sql: string): D1HttpStatement;
	batch(statements: D1HttpStatement[]): Promise<D1HttpResult[]>;
};
type D1HttpConfig = {
	accountId: string;
	databaseId: string;
	apiToken: string;
};
type RecordedRequest = {
	url: string;
	init: {
		headers: Record<string, string>;
		body: string;
	};
};
type Callable = (...args: never[]) => unknown;

async function importUnknown(specifier: string): Promise<unknown> {
	return import(specifier);
}

function moduleFunction<T extends Callable>(
	moduleValue: unknown,
	name: string,
): T {
	if (!isRecord(moduleValue) || typeof moduleValue[name] !== "function") {
		throw new TypeError(`module export ${name} must be a function`);
	}
	return moduleValue[name] as T;
}

const d1HttpModule = await importUnknown(
	new URL("../../server/d1-http-binding.mjs", import.meta.url).href,
);
const createD1HttpBinding = moduleFunction<
	(config: D1HttpConfig, options?: { fetch?: typeof fetch }) => D1HttpBinding
>(d1HttpModule, "createD1HttpBinding");
const resolveD1HttpConfig = moduleFunction<
	(env?: Record<string, unknown>) => D1HttpConfig | null
>(d1HttpModule, "resolveD1HttpConfig");

const dockerServerModule = await importUnknown(
	new URL("../../server/docker-server.mjs", import.meta.url).href,
);
const createDockerServer = moduleFunction<
	(options?: DockerServerOptions) => Server
>(dockerServerModule, "createDockerServer");
const executionContext = moduleFunction<() => DockerExecutionContext>(
	dockerServerModule,
	"executionContext",
);
const requestHeaders = moduleFunction<
	(rawHeaders: readonly string[]) => Headers
>(dockerServerModule, "requestHeaders");
const requestUrl = moduleFunction<
	(request: DockerRequest, fallbackPort?: number) => string
>(dockerServerModule, "requestUrl");
const resolveDockerEnv = moduleFunction<
	(
		sourceEnv?: Record<string, unknown>,
		options?: { fetch?: typeof fetch },
	) => Record<string, unknown> & { GEMINI_DB?: D1HttpBinding }
>(dockerServerModule, "resolveDockerEnv");
const startDockerServer = moduleFunction<
	(options?: DockerServerOptions) => Promise<Server>
>(dockerServerModule, "startDockerServer");

function listen(server: Server): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function withStderrWrite<T>(
	write: typeof process.stderr.write,
	run: () => T | PromiseLike<T>,
): Promise<T> {
	const original = process.stderr.write;
	process.stderr.write = write;
	try {
		return await run();
	} finally {
		process.stderr.write = original;
	}
}
function close(server: Server): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
}

function serverPort(server: Server): number {
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected an IP server address");
	}
	return address.port;
}

async function responseJsonRecord(response: Response): Promise<UnknownRecord> {
	const value: unknown = await response.json();
	if (!isRecord(value)) throw new TypeError("expected a JSON object response");
	return value;
}

function recordedRequest(input: FetchInput, init?: FetchInit): RecordedRequest {
	if (!init || typeof init.body !== "string" || !isRecord(init.headers)) {
		throw new TypeError("expected D1 request headers and body");
	}
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(init.headers)) {
		if (typeof value !== "string") {
			throw new TypeError(`expected string header ${name}`);
		}
		headers[name] = value;
	}
	return { url: String(input), init: { headers, body: init.body } };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

describe("docker server", () => {
	test("marks adapter execution contexts as Docker runtime", () => {
		assert.equal(executionContext().runtimeProfile, "docker");
	});
	test("normalizes raw Node headers and forwarded request URLs", async () => {
		const headers = requestHeaders([
			"X-Test",
			"one",
			"x-test",
			"two",
			"Host",
			"worker.example",
		]);
		assert.equal(headers.get("x-test"), "one, two");
		assert.equal(headers.get("host"), "worker.example");

		const url = requestUrl(
			{
				headers: {
					host: "internal.example",
					"x-forwarded-host": "api.example, proxy.example",
					"x-forwarded-proto": "https, http",
				},
				url: "/v1/models?q=1",
			},
			9999,
		);
		assert.equal(url, "https://api.example/v1/models?q=1");

		const fallbackUrl = requestUrl(
			{
				headers: {
					host: "internal.example",
					"x-forwarded-proto": ["https", "http"],
				},
				url: "/v1/models",
			},
			9999,
		);
		assert.equal(fallbackUrl, "https://internal.example/v1/models");
	});
	test("adapts Node HTTP requests to Worker fetch with streamed bodies", async () => {
		const seen: {
			url?: string;
			method?: string;
			env?: Record<string, unknown>;
			body?: string;
		} = {};
		const server = createDockerServer({
			port: 0,
			env: { API_KEYS: "", CUSTOM_ENV: "ok" },
			worker: {
				async fetch(request, env, ctx) {
					seen.url = request.url;
					seen.method = request.method;
					seen.env = env;
					seen.body = await request.text();
					ctx.waitUntil(Promise.resolve());
					return new Response(
						JSON.stringify({
							url: request.url,
							method: request.method,
							body: seen.body,
							env: env.CUSTOM_ENV,
						}),
						{
							status: 201,
							headers: {
								"content-type": "application/json",
								"x-adapter": "docker",
							},
						},
					);
				},
			},
		});
		await listen(server);
		try {
			const port = serverPort(server);
			const resp = await fetch(`http://127.0.0.1:${port}/v1/test`, {
				method: "POST",
				headers: {
					"content-type": "text/plain",
					"x-forwarded-proto": "https",
					host: "worker.example",
				},
				body: "hello",
			});
			assert.equal(resp.status, 201);
			assert.equal(resp.headers.get("x-adapter"), "docker");
			const body = await responseJsonRecord(resp);
			assert.match(body.url, /^https:\/\/127\.0\.0\.1:\d+\/v1\/test$/);
			assert.equal(body.method, "POST");
			assert.equal(body.body, "hello");
			assert.equal(body.env, "ok");
			assert.equal(seen.body, "hello");
		} finally {
			await close(server);
		}
	});
	test("does not stream response bodies for HEAD requests", async () => {
		const seen: { method?: string } = {};
		const server = createDockerServer({
			worker: {
				async fetch(request) {
					seen.method = request.method;
					return new Response("body should not be sent", {
						status: 200,
						headers: {
							"x-head-check": "ok",
						},
					});
				},
			},
		});
		await listen(server);
		try {
			const port = serverPort(server);
			const resp = await fetch(`http://127.0.0.1:${port}/`, {
				method: "HEAD",
			});
			assert.equal(resp.status, 200);
			assert.equal(resp.headers.get("x-head-check"), "ok");
			assert.equal(await resp.text(), "");
			assert.equal(seen.method, "HEAD");
		} finally {
			await close(server);
		}
	});
	test("keeps representative Docker responses aligned with the Worker entrypoint", async () => {
		const env = { API_KEYS: "required" };
		const server = createDockerServer({ env, worker: worker });
		await listen(server);
		try {
			const port = serverPort(server);
			for (const path of ["/", "/v1/models", "/missing"]) {
				const direct = await worker.fetch(
					new Request(`http://127.0.0.1:${port}${path}`),
					env,
					{ waitUntil() {} },
				);
				const docker = await fetch(`http://127.0.0.1:${port}${path}`);
				assert.equal(docker.status, direct.status, path);
				assert.equal(
					docker.headers.get("content-type"),
					direct.headers.get("content-type"),
					path,
				);
				assert.equal(
					docker.headers.get("access-control-allow-origin"),
					direct.headers.get("access-control-allow-origin"),
					path,
				);
				assert.equal(await docker.text(), await direct.text(), path);
			}
		} finally {
			await close(server);
		}
	});
	test("propagates Docker client disconnects to the Worker request signal", async () => {
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let markAborted: (reason: unknown) => void = () => {};
		const aborted = new Promise<unknown>((resolve) => {
			markAborted = resolve;
		});
		const server = createDockerServer({
			worker: {
				async fetch(request) {
					markStarted();
					request.signal.addEventListener(
						"abort",
						() => markAborted(request.signal.reason),
						{ once: true },
					);
					await aborted;
					return new Response("aborted");
				},
			},
		});
		await listen(server);
		try {
			const port = serverPort(server);
			const controller = new AbortController();
			const response = fetch(`http://127.0.0.1:${port}/slow`, {
				signal: controller.signal,
			});
			await started;
			controller.abort();
			await assert.rejects(() => response, /abort/i);
			const reason = await aborted;
			assert.match(String(reason), /docker client disconnected/);
		} finally {
			await close(server);
		}
	});
	test("returns generic JSON errors for adapter failures", async () => {
		const server = createDockerServer({
			worker: {
				async fetch() {
					throw new Error("boom");
				},
			},
		});
		await listen(server);
		const loggedErrors: string[] = [];
		await withStderrWrite(
			(chunk: string | Uint8Array) => {
				loggedErrors.push(String(chunk));
				return true;
			},
			async () => {
				try {
					const port = serverPort(server);
					const resp = await fetch(`http://127.0.0.1:${port}/`);
					assert.equal(resp.status, 500);
					assert.match(
						resp.headers.get("content-type"),
						/^application\/json\b/,
					);
					assert.deepEqual(await resp.json(), {
						error: { message: "internal server error" },
					});
				} finally {
					await close(server);
				}
			},
		);
		assert.equal(loggedErrors.length, 1);
		assert.match(loggedErrors[0], /boom/);
	});
	test("injects Docker D1 binding only for complete HTTP config", async () => {
		assert.equal(resolveD1HttpConfig({}), null);
		try {
			resolveDockerEnv({
				D1_ACCOUNT_ID: "account",
				D1_API_TOKEN: "token-secret-fragment",
			});
			throw new Error("expected partial D1 config to throw");
		} catch (err) {
			const message = errorMessage(err);
			assert.match(message, /partial D1 HTTP configuration/);
			assert.doesNotMatch(message, /token-secret-fragment/);
		}

		const env = resolveDockerEnv(
			{
				D1_ACCOUNT_ID: "account",
				D1_DATABASE_ID: "database",
				D1_API_TOKEN: "token-secret-fragment",
			},
			{
				async fetch() {
					return new Response(
						JSON.stringify({
							success: true,
							result: [{ results: [], meta: {} }],
						}),
					);
				},
			},
		);
		assert.equal(typeof env.GEMINI_DB?.prepare, "function");
	});
	test("rejects invalid runtime config before the Docker server listens", async () => {
		await assert.rejects(
			() =>
				startDockerServer({
					port: 0,
					env: { LOG_REQUESTS: "yes" },
					worker: { ...worker, assertRuntimeConfig },
				}),
			/LOG_REQUESTS must be true or false/,
		);
		const server = await startDockerServer({
			host: "127.0.0.1",
			port: 0,
			env: {},
			worker: {
				async fetch() {
					return new Response("ok");
				},
			},
		});
		try {
			await new Promise<void>((resolve) => {
				if (server.listening) resolve();
				else server.once("listening", resolve);
			});
			assert.equal(server.listening, true);
		} finally {
			await close(server);
		}
	});
	test("maps D1 HTTP first all and run without leaking params or tokens in errors", async () => {
		const requests: RecordedRequest[] = [];
		const responses = [
			{
				success: true,
				result: [{ results: [{ value: "first-row" }], meta: { changes: 0 } }],
			},
			{
				success: true,
				result: [{ results: [{ id: 1 }, { id: 2 }], meta: { changes: 0 } }],
			},
			{ success: true, result: [{ results: [], meta: { changes: 3 } }] },
		];
		const binding = createD1HttpBinding(
			{
				accountId: "account",
				databaseId: "database",
				apiToken: "d1-token-secret",
			},
			{
				async fetch(url: FetchInput, init?: FetchInit) {
					requests.push(recordedRequest(url, init));
					return new Response(JSON.stringify(responses.shift()), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				},
			},
		);

		assert.equal(
			await binding
				.prepare("SELECT ? AS value")
				.bind("__Secure-1PSID=secret-cookie")
				.first("value"),
			"first-row",
		);
		assert.deepEqual((await binding.prepare("SELECT * FROM t").all()).results, [
			{ id: 1 },
			{ id: 2 },
		]);
		assert.deepEqual(
			await binding
				.prepare("UPDATE t SET a = ?")
				.bind("session-token-secret")
				.run(),
			{
				success: true,
				meta: { changes: 3 },
			},
		);
		const firstRequest = requests[0];
		if (!firstRequest) throw new Error("expected a D1 HTTP request");
		assert.match(
			firstRequest.url,
			/\/accounts\/account\/d1\/database\/database\/query$/,
		);
		assert.equal(
			firstRequest.init.headers.authorization,
			"Bearer d1-token-secret",
		);
		assert.match(firstRequest.init.body, /secret-cookie/);

		const failing = createD1HttpBinding(
			{
				accountId: "account",
				databaseId: "database",
				apiToken: "d1-token-secret",
			},
			{
				async fetch() {
					return new Response(
						JSON.stringify({
							success: false,
							errors: [
								{
									code: "7500",
									message:
										"bad __Secure-1PSID=secret-cookie session-token-secret d1-token-secret",
								},
							],
						}),
						{ status: 200 },
					);
				},
			},
		);
		await assert.rejects(
			() =>
				failing
					.prepare("SELECT ?")
					.bind("__Secure-1PSID=secret-cookie", "session-token-secret")
					.all(),
			/D1 HTTP query failed code=7500/,
		);
		try {
			await failing
				.prepare("SELECT ?")
				.bind("__Secure-1PSID=secret-cookie", "session-token-secret")
				.all();
		} catch (err) {
			const message = errorMessage(err);
			assert.doesNotMatch(
				message,
				/secret-cookie|session-token-secret|d1-token-secret/,
			);
		}

		const fetchThrows = createD1HttpBinding(
			{
				accountId: "account",
				databaseId: "database",
				apiToken: "d1-token-secret",
			},
			{
				async fetch() {
					throw new Error(
						"network body __Secure-1PSID=secret-cookie session-token-secret d1-token-secret",
					);
				},
			},
		);
		try {
			await fetchThrows
				.prepare("SELECT ?")
				.bind("__Secure-1PSID=secret-cookie", "session-token-secret")
				.all();
			throw new Error("expected D1 fetch failure to throw");
		} catch (err) {
			const message = errorMessage(err);
			assert.match(message, /D1 HTTP query failed before response/);
			assert.doesNotMatch(
				message,
				/secret-cookie|session-token-secret|d1-token-secret/,
			);
		}
	});
	test("maps ordered D1 HTTP batches and rejects unsafe or malformed batches", async () => {
		const requests: RecordedRequest[] = [];
		const responses = [
			{
				success: true,
				result: [
					{ success: true, results: [{ id: 1 }], meta: { changes: 0 } },
					{ success: true, results: [], meta: { changes: 2 } },
				],
			},
			{ success: true, result: [] },
			{
				success: true,
				result: [
					{ success: true, results: [], meta: { changes: 0 } },
					{ success: false, results: [], meta: { changes: 0 } },
				],
			},
		];
		const fetchImpl = async (url: FetchInput, init?: FetchInit) => {
			requests.push(recordedRequest(url, init));
			return new Response(JSON.stringify(responses.shift()), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const binding = createD1HttpBinding(
			{
				accountId: "account",
				databaseId: "database",
				apiToken: "d1-token-secret",
			},
			{ fetch: fetchImpl },
		);
		const statements = [
			binding.prepare("SELECT ? AS id").bind(1),
			binding.prepare("UPDATE t SET value = ?").bind("session-token-secret"),
		];
		assert.deepEqual(await binding.batch(statements), [
			{ success: true, results: [{ id: 1 }], meta: { changes: 0 } },
			{ success: true, results: [], meta: { changes: 2 } },
		]);
		const firstRequest = requests[0];
		if (!firstRequest) throw new Error("expected a D1 batch request");
		assert.deepEqual(JSON.parse(firstRequest.init.body), {
			batch: [
				{ sql: "SELECT ? AS id", params: [1] },
				{
					sql: "UPDATE t SET value = ?",
					params: ["session-token-secret"],
				},
			],
		});
		assert.deepEqual(await binding.batch([]), []);
		assert.equal(requests.length, 1);

		const otherBinding = createD1HttpBinding(
			{
				accountId: "account",
				databaseId: "other-database",
				apiToken: "other-token-secret",
			},
			{ fetch: fetchImpl },
		);
		await assert.rejects(
			() => binding.batch([otherBinding.prepare("SELECT 1")]),
			/belongs to another binding/,
		);
		assert.equal(requests.length, 1);

		const failureCases: ReadonlyArray<readonly [string, RegExp]> = [
			["unexpected result count", /unexpected result count/],
			["failed member", /D1 HTTP batch query failed index=1/],
		];
		for (const [message, pattern] of failureCases) {
			try {
				await binding.batch(statements);
				throw new Error(`expected ${message} failure`);
			} catch (error) {
				const messageText = errorMessage(error);
				assert.match(messageText, pattern);
				assert.doesNotMatch(
					messageText,
					/secret-cookie|session-token-secret|d1-token-secret/,
				);
			}
		}
	});
});
