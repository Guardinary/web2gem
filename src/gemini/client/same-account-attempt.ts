import type { RuntimeConfig } from "../../config";
import { abortError, isAbortError } from "../../shared/abort";
import type { ErrorWithMetadata } from "../../shared/types";
import {
	configWithFreshGeminiCookie,
	rotateGeminiCookieForRetryWithReason,
} from "../cookies";
import {
	invalidGeminiCookieError,
	isDataAnalysisEmptyResponseError,
	isGeminiSemanticError,
	isInvalidGeminiCookieError,
	isLargePromptEmptyResponseError,
	shouldRetryGeminiSemanticErrorOnSameAccount,
} from "./errors";
import {
	configWithCachedGeminiBuildLabel,
	refreshGeminiBuildLabelForRetry,
	waitBeforeRetry,
} from "./retry";

type ErrorRecoveryOptions = {
	attempt: number;
	label: string;
	signal?: AbortSignal | null | undefined;
};

type SameAccountAttemptState = {
	readonly activeConfig: RuntimeConfig;
	readonly lastError: unknown;
	readonly outputStarted: boolean;
	markOutputStarted(): void;
	tryRefreshBuildLabel(context: string): Promise<boolean>;
	recoverFromError(
		error: unknown,
		options: ErrorRecoveryOptions,
	): Promise<boolean>;
};

export async function createSameAccountAttemptState(
	cfg: RuntimeConfig,
): Promise<SameAccountAttemptState> {
	let activeConfig = await configWithCachedGeminiBuildLabel(
		await configWithFreshGeminiCookie(cfg),
	);
	let buildLabelRefreshed = false;
	let cookieRefreshed = false;
	let lastError: unknown;
	let outputStarted = false;

	return {
		get activeConfig() {
			return activeConfig;
		},
		get lastError() {
			return lastError;
		},
		get outputStarted() {
			return outputStarted;
		},
		markOutputStarted() {
			outputStarted = true;
		},
		async tryRefreshBuildLabel(context) {
			if (outputStarted) return false;
			const refreshedConfig = await refreshGeminiBuildLabelForRetry(
				cfg,
				activeConfig,
				buildLabelRefreshed,
				context,
			);
			if (!refreshedConfig) return false;
			buildLabelRefreshed = true;
			activeConfig = refreshedConfig;
			return true;
		},
		async recoverFromError(error, { attempt, label, signal }) {
			if (isAbortError(error) || signal?.aborted) throw abortError(signal);
			if (
				isInvalidGeminiCookieError(error) &&
				!outputStarted &&
				!cookieRefreshed
			) {
				const rotated =
					await rotateGeminiCookieForRetryWithReason(activeConfig);
				if (rotated.config) {
					cookieRefreshed = true;
					activeConfig = await configWithCachedGeminiBuildLabel(rotated.config);
					return true;
				}
				throw invalidCookieErrorWithRotationReason(cfg, error, rotated.reason);
			}
			if (
				isInvalidGeminiCookieError(error) &&
				!outputStarted &&
				cookieRefreshed
			) {
				throw invalidCookieErrorWithRotationReason(
					cfg,
					error,
					"rotation_updated",
				);
			}
			if (
				isLargePromptEmptyResponseError(error) ||
				isDataAnalysisEmptyResponseError(error) ||
				isInvalidGeminiCookieError(error) ||
				(isGeminiSemanticError(error) &&
					!shouldRetryGeminiSemanticErrorOnSameAccount(error))
			) {
				throw error;
			}
			lastError = error;
			if (outputStarted) throw error;
			return waitBeforeRetry(cfg, attempt, error, label, signal);
		},
	};
}

function invalidCookieErrorWithRotationReason(
	cfg: RuntimeConfig,
	error: unknown,
	reason: unknown,
): unknown {
	const meta =
		error && typeof error === "object"
			? (error as Partial<ErrorWithMetadata>)
			: {};
	return (
		invalidGeminiCookieError(
			cfg,
			meta.upstreamStatus || meta.status || 401,
			typeof meta.rawLength === "number" ? meta.rawLength : null,
			reason,
		) || error
	);
}
