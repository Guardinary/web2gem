import { throwIfAborted } from "../../shared/abort";
import type { ErrorWithMetadata } from "../../shared/types";
import type { SocketTimeoutScope } from "./socket-types";

export function socketTimeoutError(
	stage: unknown,
	timeoutMs: unknown,
): ErrorWithMetadata {
	const err: ErrorWithMetadata = new Error(
		`socket: ${stage} timed out after ${timeoutMs}ms`,
	);
	err.code = "socket_timeout";
	return err;
}

export function closeSocketQuietly(socket: unknown): void {
	const candidate = socket as { close?: unknown } | null | undefined;
	if (typeof candidate?.close !== "function") return;
	try {
		candidate.close();
	} catch (_) {}
}

export function withSocketTimeout<T>(
	promise: PromiseLike<T> | T,
	timeoutMs: unknown,
	stage: unknown,
	socket: unknown,
	signal?: AbortSignal | null,
): Promise<T> {
	throwIfAborted(signal);
	const n = Number(timeoutMs);
	if (!Number.isFinite(n) || n <= 0) {
		return Promise.resolve(promise).then((value: T) => {
			throwIfAborted(signal);
			return value;
		});
	}
	let timer: ReturnType<typeof setTimeout> | null = null;
	return new Promise<T>((resolve, reject) => {
		timer = setTimeout(() => {
			closeSocketQuietly(socket);
			reject(socketTimeoutError(stage, n));
		}, n);
		Promise.resolve(promise).then(
			(value: T) => {
				if (timer) clearTimeout(timer);
				try {
					throwIfAborted(signal);
					resolve(value);
				} catch (e) {
					reject(e);
				}
			},
			(err: unknown) => {
				if (timer) clearTimeout(timer);
				try {
					throwIfAborted(signal);
					reject(err);
				} catch (e) {
					reject(e);
				}
			},
		);
	});
}

export function createSocketTimeoutScope(
	timeoutMs: unknown,
	socket: unknown,
	signal?: AbortSignal | null,
): SocketTimeoutScope {
	const n = Number(timeoutMs);
	if (!Number.isFinite(n) || n <= 0) {
		return {
			wait<T>(promise: PromiseLike<T> | T): Promise<T> {
				return Promise.resolve(promise).then((value: T) => {
					throwIfAborted(signal);
					return value;
				});
			},
			clear() {},
		};
	}
	let timer: ReturnType<typeof setTimeout> | null = null;
	let rejectIdle: ((reason?: unknown) => void) | null = null;
	const idle = new Promise<never>((_, reject) => {
		rejectIdle = reject;
	});
	const clear = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};
	const arm = (stage: unknown) => {
		clear();
		timer = setTimeout(() => {
			timer = null;
			closeSocketQuietly(socket);
			rejectIdle?.(socketTimeoutError(stage, n));
		}, n);
	};
	return {
		async wait<T>(promise: PromiseLike<T> | T, stage: unknown): Promise<T> {
			throwIfAborted(signal);
			arm(stage);
			try {
				const value = await Promise.race([Promise.resolve(promise), idle]);
				clear();
				throwIfAborted(signal);
				return value;
			} catch (e) {
				clear();
				throwIfAborted(signal);
				throw e;
			}
		},
		clear,
	};
}
