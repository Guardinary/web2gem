import type { ErrorWithMetadata } from "./types";

export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
	const wait = schedulerWait();
	if (wait) {
		if (!signal) return wait(ms);
		throwIfAborted(signal);
		return wait(ms, { signal }).catch((error: unknown) => {
			if (signal.aborted) throw abortError(signal);
			throw error;
		});
	}
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

type SchedulerWait = (
	ms: number,
	options?: { signal?: AbortSignal | null },
) => Promise<void>;

function schedulerWait(): SchedulerWait | null {
	const scheduler = (globalThis as { scheduler?: { wait?: SchedulerWait } })
		.scheduler;
	return typeof scheduler?.wait === "function"
		? scheduler.wait.bind(scheduler)
		: null;
}

export function timeoutSignal(ms: unknown): AbortSignal | undefined {
	const duration = Number(ms);
	if (!Number.isFinite(duration) || duration <= 0) return undefined;
	return AbortSignal.timeout(duration);
}

export function abortError(signal?: AbortSignal | null): ErrorWithMetadata {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	const error: ErrorWithMetadata = new Error(
		reason ? String(reason) : "request aborted",
	);
	error.name = "AbortError";
	error.code = "request_aborted";
	return error;
}

export function isAbortError(error: unknown): boolean {
	const candidate = error as Partial<ErrorWithMetadata> | null | undefined;
	return (
		!!candidate &&
		(candidate.name === "AbortError" || candidate.code === "request_aborted")
	);
}

export function throwIfAborted(signal?: AbortSignal | null): void {
	if (signal?.aborted) throw abortError(signal);
}
