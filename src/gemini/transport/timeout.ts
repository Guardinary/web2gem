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
