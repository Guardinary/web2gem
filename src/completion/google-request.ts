import type { RuntimeConfig } from "../config";
import type { CompletionProvider } from "./ports";
import { resolveModel } from "../models";
import type { ResolvedModel } from "../models";
import {
	googleFunctionCallingConfig,
	parseGoogleToolChoicePolicy,
	validateGoogleToolChoiceConfig,
} from "../toolcall/policy-google";
import {
	createToolBundle,
	filterToolBundleByPolicy,
} from "../toolcall/tool-bundle";
import { googleToolChoiceInstruction } from "../promptcompat/google";
import { log } from "../shared/logging";
import {
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
	upstreamErrorStatus,
} from "../shared/errors";
import { prepareGoogleGeminiContext } from "./context";
import { ensureInlineToolPrompt } from "./tool-prompt-guard";
import type { ContextFileResult, FileRef, LooseRequest } from "./types";
import { hasCompletionError } from "./types";

export type GoogleCompletionPrepareError = {
	message: string;
	status: number;
	code?: string;
	reason?: string;
};

export type PreparedGoogleCompletion = {
	rm: Extract<ResolvedModel, { name: string }>;
	effectiveReq: LooseRequest;
	effectiveGoogleTools: LooseRequest[] | null;
	hasTools: boolean;
	prompt: string;
	fileRefs: FileRef[] | null;
	promptTokens: number;
	contextFiles: ContextFileResult | null;
};

export async function prepareGoogleCompletion(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	req: LooseRequest,
	path: string,
): Promise<PreparedGoogleCompletion | { error: GoogleCompletionPrepareError }> {
	const m = /\/v(?:1beta|1)\/models\/([^:?/]+)/.exec(path);
	const modelFromPath = m?.[1]
		? decodeURIComponent(m[1]).replace(/^models\//, "")
		: undefined;
	const rm = resolveModel(modelFromPath, cfg.default_model);
	if (rm.name === undefined) {
		log(
			cfg,
			`google completion model rejected model=${String(modelFromPath ?? "(default)")}`,
		);
		return {
			error: { message: rm.error, status: 400, code: "model_not_found" },
		};
	}

	const toolBundle = createToolBundle(req.tools);
	const toolConfigViolation = validateGoogleToolChoiceConfig(req, toolBundle);
	if (toolConfigViolation) {
		return {
			error: {
				message: toolConfigViolation.message,
				status: 400,
				code: "invalid_tool_choice",
			},
		};
	}

	const fcMode = String(googleFunctionCallingConfig(req).mode || "AUTO")
		.trim()
		.toUpperCase();
	const toolPolicy = parseGoogleToolChoicePolicy(req, toolBundle);
	const effectiveToolBundle = filterToolBundleByPolicy(toolBundle, toolPolicy);
	const effectiveGoogleTools = effectiveToolBundle.openAIFunctionTools.length
		? effectiveToolBundle.openAIFunctionTools
		: null;
	const effectiveReq = { ...req, tools: effectiveGoogleTools || [] };
	const hasTools = !!effectiveGoogleTools && fcMode !== "NONE";
	const toolChoiceInstruction = googleToolChoiceInstruction(effectiveReq);
	const ctx = await prepareGoogleGeminiContext(
		cfg,
		provider,
		effectiveReq,
		hasTools,
		effectiveToolBundle,
		toolChoiceInstruction,
	);
	if (hasCompletionError(ctx)) {
		const code = upstreamErrorCode(ctx.error) || "context_file_upload_failed";
		const error: GoogleCompletionPrepareError = {
			message: upstreamErrorMessage(ctx.error),
			status: upstreamErrorStatus(ctx.error) || 502,
			code,
		};
		const reason = upstreamErrorReason(ctx.error);
		if (reason) error.reason = reason;
		return {
			error: {
				...error,
			},
		};
	}
	let { prompt } = ctx;
	const { fileRefs, promptTokens, contextFiles } = ctx;
	const promptToolSource = effectiveToolBundle.defs.length
		? effectiveToolBundle
		: toolBundle;
	prompt = ensureInlineToolPrompt(
		prompt,
		promptToolSource,
		toolChoiceInstruction,
		contextFiles,
		ctx.promptMetadata,
	);
	if (!String(prompt || "").trim())
		return { error: { message: "empty content", status: 400 } };

	return {
		rm,
		effectiveReq,
		effectiveGoogleTools,
		hasTools,
		prompt,
		fileRefs,
		promptTokens,
		contextFiles,
	};
}
