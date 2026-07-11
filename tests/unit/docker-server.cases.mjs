import { assert } from "./assertions.js";
import {
	createD1HttpBinding,
	resolveD1HttpConfig,
} from "../../scripts/d1-http-binding.mjs";
import {
	createDockerServer,
	executionContext,
	requestHeaders,
	requestUrl,
	resolveDockerEnv,
	startDockerServer,
} from "../../scripts/docker-server.mjs";
import { mod } from "./helpers.js";

export const suiteName = "docker server";
export const cases = [
	[
		"marks adapter execution contexts as Docker runtime",
		() => {
			assert.equal(executionContext().runtimeProfile, "docker");
		},
	],
	[
		"normalizes raw Node headers and forwarded request URLs",
		async () => {
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
		},
	],
	[
		"adapts Node HTTP requests to Worker fetch with streamed bodies",
		async () => {
			const seen = {};
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
				const port = server.address().port;
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
				const body = await resp.json();
				assert.match(body.url, /^https:\/\/127\.0\.0\.1:\d+\/v1\/test$/);
				assert.equal(body.method, "POST");
				assert.equal(body.body, "hello");
				assert.equal(body.env, "ok");
				assert.equal(seen.body, "hello");
			} finally {
				await close(server);
			}
		},
	],
	[
		"does not stream response bodies for HEAD requests",
		async () => {
			const seen = {};
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
				const port = server.address().port;
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
		},
	],
	[
		"keeps representative Docker responses aligned with the Worker entrypoint",
		async () => {
			const env = { API_KEYS: "required" };
			const server = createDockerServer({ env, worker: mod.default });
			await listen(server);
			try {
				const port = server.address().port;
				for (const path of ["/", "/v1/models", "/missing"]) {
					const direct = await mod.default.fetch(
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
		},
	],
	[
		"propagates Docker client disconnects to the Worker request signal",
		async () => {
			let markStarted;
			const started = new Promise((resolve) => {
				markStarted = resolve;
			});
			let markAborted;
			const aborted = new Promise((resolve) => {
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
				const port = server.address().port;
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
		},
	],
	[
		"returns generic JSON errors for adapter failures",
		async () => {
			const server = createDockerServer({
				worker: {
					async fetch() {
						throw new Error("boom");
					},
				},
			});
			await listen(server);
			try {
				const port = server.address().port;
				const resp = await fetch(`http://127.0.0.1:${port}/`);
				assert.equal(resp.status, 500);
				assert.match(resp.headers.get("content-type"), /^application\/json\b/);
				assert.deepEqual(await resp.json(), {
					error: { message: "internal server error" },
				});
			} finally {
				await close(server);
			}
		},
	],
	[
		"injects Docker D1 binding only for complete HTTP config",
		async () => {
			assert.equal(resolveD1HttpConfig({}), null);
			try {
				resolveDockerEnv({
					D1_ACCOUNT_ID: "account",
					D1_API_TOKEN: "token-secret-fragment",
				});
				throw new Error("expected partial D1 config to throw");
			} catch (err) {
				assert.match(err.message, /partial D1 HTTP configuration/);
				assert.doesNotMatch(err.message, /token-secret-fragment/);
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
			assert.equal(typeof env.GEMINI_DB.prepare, "function");
		},
	],
	[
		"rejects invalid runtime config before the Docker server listens",
		async () => {
			await assert.rejects(
				() => startDockerServer({ port: 0, env: { LOG_REQUESTS: "yes" } }),
				/LOG_REQUESTS must be true or false/,
			);
		},
	],
	[
		"maps D1 HTTP first all and run without leaking params or tokens in errors",
		async () => {
			const requests = [];
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
					async fetch(url, init) {
						requests.push({ url: String(url), init });
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
			assert.deepEqual(
				(await binding.prepare("SELECT * FROM t").all()).results,
				[{ id: 1 }, { id: 2 }],
			);
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
			assert.match(
				requests[0].url,
				/\/accounts\/account\/d1\/database\/database\/query$/,
			);
			assert.equal(
				requests[0].init.headers.authorization,
				"Bearer d1-token-secret",
			);
			assert.match(requests[0].init.body, /secret-cookie/);

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
				const message = String(err.message || err);
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
				assert.match(err.message, /D1 HTTP query failed before response/);
				assert.doesNotMatch(
					err.message,
					/secret-cookie|session-token-secret|d1-token-secret/,
				);
			}
		},
	],
	[
		"maps ordered D1 HTTP batches and rejects unsafe or malformed batches",
		async () => {
			const requests = [];
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
			const fetchImpl = async (url, init) => {
				requests.push({ url: String(url), init });
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
			assert.deepEqual(JSON.parse(requests[0].init.body), {
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

			for (const [message, pattern] of [
				["unexpected result count", /unexpected result count/],
				["failed member", /D1 HTTP batch query failed index=1/],
			]) {
				try {
					await binding.batch(statements);
					throw new Error(`expected ${message} failure`);
				} catch (error) {
					assert.match(error.message, pattern);
					assert.doesNotMatch(
						error.message,
						/secret-cookie|session-token-secret|d1-token-secret/,
					);
				}
			}
		},
	],
];

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function close(server) {
	return new Promise((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
}
