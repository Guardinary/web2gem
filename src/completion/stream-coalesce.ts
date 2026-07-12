import { codePointLengthAtLeast } from "../shared/tokens";
import { isAbortError } from "../shared/abort";
import type {
	CompletionProvider,
	CompletionProviderOptions,
	CompletionTextInput,
} from "./ports";

export type StreamConsumeOptions = CompletionProviderOptions;

export type TextDeltaCoalesceOptions = {
	coalesceTextDeltas?: boolean;
	minCoalescedTextChars?: number;
	maxCoalescedTextWaitMs?: number;
};

export type StreamConsumeInternalOptions = StreamConsumeOptions &
	TextDeltaCoalesceOptions;

type CoalescedTextRaceResult =
	| { type: "next"; value: IteratorResult<unknown> }
	| { type: "timer" };

const MIN_COALESCED_TEXT_DELTA_CHARS = 64;
const MAX_COALESCED_TEXT_DELTA_WAIT_MS = 20;

function streamCompletionText(
	provider: CompletionProvider,
	input: CompletionTextInput,
	options: StreamConsumeOptions = {},
) {
	const providerOptions: CompletionProviderOptions = {};
	if (options.signal) providerOptions.signal = options.signal;
	return provider.streamText(input, providerOptions);
}

async function* coalesceTextDeltas(
	deltas: AsyncIterable<unknown>,
	options: TextDeltaCoalesceOptions = {},
): AsyncIterable<string> {
	const minChars = positiveCoalesceNumber(
		options.minCoalescedTextChars,
		MIN_COALESCED_TEXT_DELTA_CHARS,
	);
	const maxWaitMs = nonNegativeCoalesceNumber(
		options.maxCoalescedTextWaitMs,
		MAX_COALESCED_TEXT_DELTA_WAIT_MS,
	);
	const iterator = deltas[Symbol.asyncIterator]();
	let next = iterator.next();
	let pending = "";
	let timer: Promise<CoalescedTextRaceResult> | null = null;
	let firstText = true;

	const scheduleTimer = () => {
		if (!timer && maxWaitMs > 0)
			timer = new Promise((resolve) =>
				setTimeout(() => resolve({ type: "timer" }), maxWaitMs),
			);
	};
	const flush = () => {
		const out = pending;
		pending = "";
		timer = null;
		return out;
	};

	try {
		while (true) {
			const nextResult: Promise<CoalescedTextRaceResult> = next.then(
				(value) => ({ type: "next", value }),
			);
			const result: CoalescedTextRaceResult = timer
				? await Promise.race([nextResult, timer])
				: await nextResult;

			if (result.type === "timer") {
				if (pending) yield flush();
				continue;
			}

			const item = result.value;
			if (item.done) {
				if (pending) yield flush();
				return;
			}
			next = iterator.next();

			const text = String(item.value || "");
			if (!text) continue;
			if (firstText) {
				firstText = false;
				yield text;
				continue;
			}

			pending += text;
			if (codePointLengthAtLeast(pending, minChars)) {
				yield flush();
			} else {
				scheduleTimer();
			}
		}
	} catch (e) {
		if (!isAbortError(e) && pending) yield flush();
		throw e;
	} finally {
		if (iterator.return) {
			try {
				await iterator.return();
			} catch (_) {}
		}
	}
}

export function completionTextDeltas(
	provider: CompletionProvider,
	input: CompletionTextInput,
	options: StreamConsumeInternalOptions = {},
): AsyncIterable<unknown> {
	const deltas = streamCompletionText(provider, input, options);
	return options.coalesceTextDeltas
		? coalesceTextDeltas(deltas, options)
		: deltas;
}

function positiveCoalesceNumber(value: unknown, fallback: number): number {
	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeCoalesceNumber(value: unknown, fallback: number): number {
	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}
