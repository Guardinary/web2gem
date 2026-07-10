import { closeSocketQuietly } from "./timeout";
import type { SocketLike, SocketPool } from "./socket-types";

export const SOCKET_KEEP_ALIVE_IDLE_MS = 30000;
export const SOCKET_KEEP_ALIVE_MAX_IDLE_PER_ORIGIN = 2;

export function createSocketPool(): SocketPool {
	return { idle: new Map() };
}

const defaultSocketPool = createSocketPool();

export function getDefaultSocketPool(): SocketPool {
	return defaultSocketPool;
}

export function socketPoolKey(u: URL, secure: boolean, port: number): string {
	return `${secure ? "https" : "http"}://${u.hostname}:${port}`;
}

export function takeIdleSocket(
	pool: SocketPool,
	key: string,
): SocketLike | null {
	const entries = pool.idle.get(key);
	if (!entries) return null;
	const now = Date.now();
	for (;;) {
		const entry = entries.pop();
		if (!entry) {
			pool.idle.delete(key);
			return null;
		}
		if (!entries.length) pool.idle.delete(key);
		if (entry.expiresAt > now) return entry.socket;
		closeSocketQuietly(entry.socket);
	}
}

export function putIdleSocket(
	pool: SocketPool,
	key: string,
	socket: SocketLike,
): void {
	let entries = pool.idle.get(key);
	if (!entries) {
		entries = [];
		pool.idle.set(key, entries);
	}
	while (entries.length >= SOCKET_KEEP_ALIVE_MAX_IDLE_PER_ORIGIN)
		closeSocketQuietly(entries.shift()?.socket);
	entries.push({ socket, expiresAt: Date.now() + SOCKET_KEEP_ALIVE_IDLE_MS });
}

export function closeIdleSocketPool(pool?: SocketPool | null): void {
	const target = pool === undefined ? defaultSocketPool : pool;
	if (!target) return;
	const entries = Array.from(target.idle.values()).flat();
	target.idle.clear();
	for (const entry of entries) closeSocketQuietly(entry.socket);
}
