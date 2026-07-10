import { codePointLengthAtLeast } from "../../shared/tokens";

export const MIN_DELTA_FLUSH_CHARS = 64;
export const MAX_DELTA_FLUSH_WAIT_MS = 20;

export type DeltaCoalescerOptions = {
	emitFirstImmediately?: boolean;
};

export function createDeltaCoalescer(
	sendDeltaFrame: (delta: Record<string, string>) => void | Promise<void>,
	minFlushChars: number = MIN_DELTA_FLUSH_CHARS,
	maxFlushWaitMs: number = MAX_DELTA_FLUSH_WAIT_MS,
	options: DeltaCoalescerOptions = {},
): {
	append: (field: string, text: unknown) => void | Promise<void>;
	flush: () => void | Promise<void>;
} {
	let pendingField = "";
	let pendingText = "";
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let emitted = false;

	const clearFlushTimer = () => {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
	};

	const flush = () => {
		clearFlushTimer();
		if (!pendingField || !pendingText) return;
		const delta = { [pendingField]: pendingText };
		pendingField = "";
		pendingText = "";
		emitted = true;
		return sendDeltaFrame(delta);
	};

	const scheduleFlush = () => {
		if (flushTimer || maxFlushWaitMs <= 0) return;
		flushTimer = setTimeout(() => {
			const result = flush();
			if (isPromiseLike(result)) result.catch(() => {});
		}, maxFlushWaitMs);
	};

	const appendBuffered = (field: string, piece: string) => {
		if (
			options.emitFirstImmediately &&
			!emitted &&
			!pendingField &&
			!pendingText
		) {
			emitted = true;
			return sendDeltaFrame({ [field]: piece });
		}
		pendingField = field;
		pendingText += piece;
		if (codePointLengthAtLeast(pendingText, minFlushChars)) return flush();
		scheduleFlush();
		return;
	};

	const append = (field: string, text: unknown) => {
		const piece = String(text || "");
		if (!field || !piece) return;
		if (pendingField && pendingField !== field) {
			const result = flush();
			if (isPromiseLike(result))
				return result.then(() => appendBuffered(field, piece));
		}
		return appendBuffered(field, piece);
	};

	return { append, flush };
}

function isPromiseLike(value: unknown): value is Promise<void> {
	return !!value && typeof (value as Promise<void>).then === "function";
}
