import type { RuntimeConfig } from "../../config";
import { uuid } from "../../shared/crypto";
import { buildPayload } from "./protocol";
import {
	createSameAccountAttemptState,
	type SameAccountAttemptState,
} from "./same-account-attempt";

/** Sentinel returned by attempt execute bodies to retry the same account loop. */
export const CONTINUE_SAME_ACCOUNT_ATTEMPT = Symbol(
	"CONTINUE_SAME_ACCOUNT_ATTEMPT",
);
export type ContinueSameAccountAttempt = typeof CONTINUE_SAME_ACCOUNT_ATTEMPT;

/** Shared Gemini file-ref shape for client generate / stream payloads. */
export type GeminiFileRef =
	| string
	| {
			ref?: unknown;
			fileRef?: unknown;
			id?: unknown;
			name?: unknown;
			filename?: unknown;
	  };

export type SameAccountGenerateContext = {
	attemptState: SameAccountAttemptState;
	body: string;
	requestId: string;
	attempt: number;
	signal: AbortSignal | null | undefined;
};

type SameAccountGenerateBaseArgs = {
	cfg: RuntimeConfig;
	prompt: string;
	modelNumber: number;
	extended: boolean;
	fileRefs: GeminiFileRef[] | null | undefined;
	label: string;
	signal?: AbortSignal | null | undefined;
};

/**
 * Shared same-account retry shell for non-stream generate / generateRich.
 * Mode-specific parse, empty handling, and hydration stay in the execute body.
 */
export async function runSameAccountGenerateAttempts<T>(
	args: SameAccountGenerateBaseArgs & {
		execute: (
			ctx: SameAccountGenerateContext,
		) => Promise<T | ContinueSameAccountAttempt>;
	},
): Promise<T> {
	const attemptState = await createSameAccountAttemptState(args.cfg);
	const requestId = uuid().toUpperCase();
	const body = buildPayload(
		args.prompt,
		args.modelNumber,
		args.extended,
		args.fileRefs || null,
		requestId,
	);
	const signal = args.signal;

	for (let attempt = 0; attempt < args.cfg.retry_attempts; attempt++) {
		try {
			const result = await args.execute({
				attemptState,
				body,
				requestId,
				attempt,
				signal,
			});
			if (result === CONTINUE_SAME_ACCOUNT_ATTEMPT) continue;
			return result;
		} catch (e) {
			if (
				await attemptState.recoverFromError(e, {
					attempt,
					label: args.label,
					signal,
				})
			)
				continue;
			throw e;
		}
	}
	throw attemptState.lastError;
}

/**
 * Shared same-account retry shell for generateStream.
 * Yields provider deltas from execute; return CONTINUE to retry without output.
 */
export async function* runSameAccountStreamAttempts(
	args: SameAccountGenerateBaseArgs & {
		execute: (
			ctx: SameAccountGenerateContext,
		) => AsyncGenerator<string, undefined | ContinueSameAccountAttempt>;
	},
): AsyncGenerator<string> {
	const attemptState = await createSameAccountAttemptState(args.cfg);
	const requestId = uuid().toUpperCase();
	const body = buildPayload(
		args.prompt,
		args.modelNumber,
		args.extended,
		args.fileRefs || null,
		requestId,
	);
	const signal = args.signal;

	for (let attempt = 0; attempt < args.cfg.retry_attempts; attempt++) {
		try {
			const result = yield* args.execute({
				attemptState,
				body,
				requestId,
				attempt,
				signal,
			});
			if (result === CONTINUE_SAME_ACCOUNT_ATTEMPT) continue;
			return;
		} catch (e) {
			if (
				await attemptState.recoverFromError(e, {
					attempt,
					label: args.label,
					signal,
				})
			)
				continue;
			throw e;
		}
	}
	if (attemptState.lastError) throw attemptState.lastError;
}
