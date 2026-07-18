import { afterEach, describe, test, vi } from "vitest";
import {
	closeIdleSocketPool,
	createSocketPool,
	putIdleSocket,
	SOCKET_KEEP_ALIVE_IDLE_MS,
	SOCKET_KEEP_ALIVE_MAX_IDLE_PER_ORIGIN,
	socketPoolKey,
	takeIdleSocket,
} from "../../../../src/gemini/transport/pool";
import { socketHttp } from "../../../../src/gemini/transport/socket";
import { assert } from "../../assertions.js";
import { fakePersistentSocketConnect, joinedWriteText } from "../../helpers.js";

describe.sequential("socket pools", () => {
	afterEach(() => {
		closeIdleSocketPool();
		vi.restoreAllMocks();
	});
	test("reuses socket HTTP keep-alive connections after complete bounded responses", async () => {
		const state = {};
		const connect = fakePersistentSocketConnect(
			[
				["HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\none"],
				["HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo"],
			],
			state,
		);
		const pool = createSocketPool();
		try {
			const first = await socketHttp(connect, "https://example.test/one", {
				keepAlive: true,
				pool,
			});
			assert.equal(first.status, 200);
			assert.equal(await first.text(), "one");

			const second = await socketHttp(connect, "https://example.test/two", {
				keepAlive: true,
				pool,
			});
			assert.equal(second.status, 200);
			assert.equal(await second.text(), "two");

			const writes = joinedWriteText(state);
			assert.equal(state.connects, 1);
			assert.match(writes, /GET \/one HTTP\/1\.1/);
			assert.match(writes, /GET \/two HTTP\/1\.1/);
			assert.equal((writes.match(/Connection: keep-alive/g) || []).length, 2);
			assert.equal(state.closed, 0);
		} finally {
			closeIdleSocketPool(pool);
		}
	});
	test("does not reuse socket HTTP connections when upstream asks to close", async () => {
		const state = {};
		const connect = fakePersistentSocketConnect(
			[
				[
					"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\none",
				],
				["HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo"],
			],
			state,
		);
		const pool = createSocketPool();
		try {
			const first = await socketHttp(
				connect,
				"https://example.test/close-one",
				{ keepAlive: true, pool },
			);
			assert.equal(await first.text(), "one");

			const second = await socketHttp(
				connect,
				"https://example.test/close-two",
				{ keepAlive: true, pool },
			);
			assert.equal(await second.text(), "two");

			assert.equal(state.connects, 2);
			assert.equal(state.closed, 1);
		} finally {
			closeIdleSocketPool(pool);
		}
	});
	test("manages socket idle pool expiry cap and explicit close", async () => {
		let now = 1000;
		const sockets = [];
		const makeSocket = (name) => {
			const socket = {
				name,
				closed: 0,
				close() {
					this.closed += 1;
				},
			};
			sockets.push(socket);
			return socket;
		};
		const pool = createSocketPool();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			const key = socketPoolKey(
				new URL("http://example.test:8080/path"),
				false,
				8080,
			);
			assert.equal(key, "http://example.test:8080");

			const first = makeSocket("first");
			const second = makeSocket("second");
			const third = makeSocket("third");
			putIdleSocket(pool, key, first);
			putIdleSocket(pool, key, second);
			putIdleSocket(pool, key, third);
			assert.equal(first.closed, 1);
			assert.equal(
				pool.idle.get(key).length,
				SOCKET_KEEP_ALIVE_MAX_IDLE_PER_ORIGIN,
			);

			assert.equal(takeIdleSocket(pool, key), third);
			now += SOCKET_KEEP_ALIVE_IDLE_MS + 1;
			assert.equal(takeIdleSocket(pool, key), null);
			assert.equal(second.closed, 1);
			assert.equal(pool.idle.has(key), false);

			const fourth = makeSocket("fourth");
			putIdleSocket(pool, key, fourth);
			closeIdleSocketPool(pool);
			assert.equal(fourth.closed, 1);
			assert.equal(pool.idle.size, 0);
			closeIdleSocketPool(null);
		} finally {
			closeIdleSocketPool(pool);
		}
		assert.deepEqual(
			sockets.map((socket) => [socket.name, socket.closed]),
			[
				["first", 1],
				["second", 1],
				["third", 0],
				["fourth", 1],
			],
		);
	});
});
