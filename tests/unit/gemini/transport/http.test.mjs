import { afterEach, beforeEach, describe, test } from "vitest";
import { httpFetch } from "../../../../src/gemini/transport/http";
import { closeIdleSocketPool } from "../../../../src/gemini/transport/pool";
import { _setConnectForTest } from "../../../../src/gemini/transport/socket";
import { assert } from "../../assertions.js";
import {
	fakePersistentSocketConnect,
	joinedWriteText,
	withConsoleLog,
	withFetch,
} from "../../helpers.js";

function resetHttpTransportOwner() {
	_setConnectForTest(null);
	closeIdleSocketPool();
}

describe.sequential("httpFetch transport selection", () => {
	beforeEach(resetHttpTransportOwner);
	afterEach(resetHttpTransportOwner);

	test("uses native AbortSignal.any for fetch timeout linking", async () => {
		const originalDescriptor = Object.getOwnPropertyDescriptor(
			AbortSignal,
			"any",
		);
		const originalAny = originalDescriptor?.value;
		assert.equal(typeof originalAny, "function");
		let calls = 0;
		let seenSignals = null;
		Object.defineProperty(AbortSignal, "any", {
			...originalDescriptor,
			value(signals) {
				calls += 1;
				seenSignals = Array.from(signals);
				return originalAny.call(AbortSignal, signals);
			},
		});
		try {
			const ac = new AbortController();
			await withFetch(
				async (_url, init = {}) => {
					assert.equal(init.signal instanceof AbortSignal, true);
					return new Response("ok");
				},
				async () => {
					const resp = await httpFetch("https://example.test/native-any", {
						socket: false,
						timeoutMs: 1000,
						signal: ac.signal,
					});
					assert.equal(await resp.text(), "ok");
				},
			);
			assert.equal(calls, 1);
			assert.equal(seenSignals[0], ac.signal);
			assert.equal(seenSignals.length, 2);
			assert.equal(seenSignals[1] instanceof AbortSignal, true);
		} finally {
			if (originalDescriptor) {
				Object.defineProperty(AbortSignal, "any", originalDescriptor);
			} else {
				delete AbortSignal.any;
			}
		}
	});

	test("enables socket keep-alive on the httpFetch upstream path", async () => {
		const state = {};
		const connect = fakePersistentSocketConnect(
			[
				["HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\none"],
				["HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo"],
			],
			state,
		);
		_setConnectForTest(connect);
		const first = await httpFetch("https://example.test/fetch-one", {
			socket: true,
			timeoutMs: 1000,
		});
		assert.equal(await first.text(), "one");

		const second = await httpFetch("https://example.test/fetch-two", {
			socket: true,
			timeoutMs: 1000,
		});
		assert.equal(await second.text(), "two");

		assert.equal(state.connects, 1);
		assert.equal(
			(joinedWriteText(state).match(/Connection: keep-alive/g) || []).length,
			2,
		);
	});

	test("falls back to fetch after a pre-response socket failure", async () => {
		let fetched = false;
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				withFetch(
					async () => {
						fetched = true;
						return new Response("fallback", { status: 202 });
					},
					async () => {
						_setConnectForTest(() => {
							const err = new Error("socket boom secret");
							err.code = "socket_boom";
							throw err;
						});
						const resp = await httpFetch("https://example.test/fallback", {
							method: "POST",
							body: "x",
							socket: true,
							timeoutMs: 100,
							cfg: { log_requests: true },
						});
						assert.equal(fetched, true);
						assert.equal(resp.status, 202);
						assert.equal(await resp.text(), "fallback");
					},
				),
		);
		assert.equal(logs.length, 1);
		assert.match(logs[0], /falling back to fetch: type=Error code=socket_boom/);
		assert.doesNotMatch(logs.join("\n"), /socket boom secret/);
	});

	test("honors disabled socket fallback policy", async () => {
		let fetched = false;
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				withFetch(
					async () => {
						fetched = true;
						return new Response("unexpected");
					},
					async () => {
						_setConnectForTest(() => {
							const err = new Error("socket disabled secret");
							err.code = "socket_disabled";
							throw err;
						});
						await assert.rejects(
							() =>
								httpFetch("https://example.test/no-policy-fallback", {
									method: "POST",
									body: "x",
									socket: true,
									socketFallback: "never",
									timeoutMs: 100,
									cfg: { log_requests: true },
								}),
							/socket disabled secret/,
						);
						assert.equal(fetched, false);
					},
				),
		);
		assert.equal(logs.length, 1);
		assert.match(
			logs[0],
			/fallback disabled for POST: type=Error code=socket_disabled/,
		);
		assert.doesNotMatch(logs.join("\n"), /socket disabled secret/);
	});

	test("replays untouched streaming request bodies through fetch fallback", async () => {
		let fetched = false;
		let fetchBody = "";
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				withFetch(
					async (_url, init = {}) => {
						fetched = true;
						fetchBody = init.body ? await new Response(init.body).text() : "";
						return new Response("fallback", { status: 202 });
					},
					async () => {
						_setConnectForTest(() => {
							const err = new Error("stream body socket secret");
							err.code = "socket_stream_body";
							throw err;
						});
						const resp = await httpFetch(
							"https://example.test/stream-body-fallback",
							{
								method: "POST",
								body: new ReadableStream({
									start(controller) {
										controller.enqueue(new TextEncoder().encode("x"));
										controller.close();
									},
								}),
								bodyLength: 1,
								socket: true,
								timeoutMs: 100,
								cfg: { log_requests: true },
							},
						);
						assert.equal(fetched, true);
						assert.equal(resp.status, 202);
						assert.equal(fetchBody, "x");
					},
				),
		);
		assert.equal(logs.length, 1);
		assert.match(
			logs[0],
			/falling back to fetch: type=Error code=socket_stream_body/,
		);
		assert.doesNotMatch(logs.join("\n"), /stream body socket secret/);
	});

	test("does not replay streaming bodies after socket consumption starts", async () => {
		let fetched = false;
		let writes = 0;
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				withFetch(
					async () => {
						fetched = true;
						return new Response("unexpected");
					},
					async () => {
						_setConnectForTest(() => ({
							readable: new ReadableStream(),
							writable: new WritableStream({
								write() {
									writes += 1;
									if (writes === 2) {
										throw new Error("stream body write secret");
									}
								},
							}),
							close() {},
						}));
						await assert.rejects(
							() =>
								httpFetch(
									"https://example.test/no-consumed-stream-body-fallback",
									{
										method: "POST",
										body: new ReadableStream({
											start(controller) {
												controller.enqueue(new TextEncoder().encode("x"));
												controller.close();
											},
										}),
										bodyLength: 1,
										socket: true,
										timeoutMs: 100,
										cfg: { log_requests: true },
									},
								),
							/stream body write secret/,
						);
						assert.equal(fetched, false);
					},
				),
		);
		assert.equal(logs.length, 1);
		assert.match(
			logs[0],
			/not falling back with streaming request body for POST: type=Error/,
		);
		assert.doesNotMatch(logs.join("\n"), /stream body write secret/);
	});

	test("does not fall back after upstream response status is exposed", async () => {
		let fetched = false;
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				withFetch(
					async () => {
						fetched = true;
						return new Response("unexpected");
					},
					async () => {
						_setConnectForTest(() => {
							const err = new Error("upstream response started secret");
							err.code = "socket_response_started";
							err.upstreamStatus = 502;
							throw err;
						});
						await assert.rejects(
							() =>
								httpFetch("https://example.test/no-fallback", {
									method: "POST",
									socket: true,
									timeoutMs: 100,
									cfg: { log_requests: true },
								}),
							/upstream response started secret/,
						);
						assert.equal(fetched, false);
					},
				),
		);
		assert.equal(logs.length, 1);
		assert.match(
			logs[0],
			/not falling back after upstream response for POST: type=Error code=socket_response_started upstreamStatus=502/,
		);
		assert.doesNotMatch(logs.join("\n"), /upstream response started secret/);
	});
});
