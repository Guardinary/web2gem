import { codePointLengthAtLeast } from "../../shared/text-metrics";

const MIN_DELTA_FLUSH_CHARS = 64;
const MAX_DELTA_FLUSH_WAIT_MS = 20;

export type DeltaCoalescerOptions = {
	emitFirstImmediately?: boolean;
};

export function createDeltaCoalescer(
	sendDeltaFrame: (delta: Record<string, string>) => void | Promise<void>,
	minFlushChars: number = MIN_DELTA_FLUSH_CHARS,
	maxFlushWaitMs: number = MAX_DELTA_FLUSH_WAIT_MS,
	options: DeltaCoalescerOptions = {},
): {
	append: (field: string, text: unknown) => Promise<void>;
	flush: () => Promise<void>;
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

	const flush = (): Promise<void> => {
		clearFlushTimer();
		if (!pendingField || !pendingText) return Promise.resolve();
		const delta = { [pendingField]: pendingText };
		pendingField = "";
		pendingText = "";
		emitted = true;
		return Promise.resolve(sendDeltaFrame(delta));
	};

	const scheduleFlush = () => {
		if (flushTimer || maxFlushWaitMs <= 0) return;
		flushTimer = setTimeout(() => {
			flush().catch(() => {});
		}, maxFlushWaitMs);
	};

	const appendBuffered = (field: string, piece: string): Promise<void> => {
		if (
			options.emitFirstImmediately &&
			!emitted &&
			!pendingField &&
			!pendingText
		) {
			emitted = true;
			return Promise.resolve(sendDeltaFrame({ [field]: piece }));
		}
		pendingField = field;
		pendingText += piece;
		if (codePointLengthAtLeast(pendingText, minFlushChars)) return flush();
		scheduleFlush();
		return Promise.resolve();
	};

	const append = (field: string, text: unknown): Promise<void> => {
		const piece = String(text || "");
		if (!field || !piece) return Promise.resolve();
		if (pendingField && pendingField !== field) {
			return flush().then(() => appendBuffered(field, piece));
		}
		return appendBuffered(field, piece);
	};

	return { append, flush };
}
