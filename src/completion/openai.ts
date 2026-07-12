import type { RuntimeConfig } from "../config";
import type { CompletionProvider } from "./ports";
import { resolveModel } from "../models";
import type { ResolvedModel } from "../models";
import {
	getStructuredResponseFormat,
	buildStructuredOutputRequirement,
} from "../toolcall/structured";
import {
	buildToolChoiceInstructionFromPolicy,
	parseOpenAIToolChoicePolicy,
} from "../toolcall/policy-openai";
import type { ToolChoicePolicy } from "../toolcall/policy-openai";
import {
	createToolBundle,
	filterToolBundleByPolicy,
} from "../toolcall/tool-bundle";
import { log } from "../shared/logging";
import {
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
	upstreamErrorStatus,
} from "../shared/errors";
import { prepareOpenAIGeminiContext } from "./context";
import { ensureInlineToolPrompt } from "./tool-prompt-guard";
import type { ContextFileResult, FileRef, LooseRequest } from "./types";
import { hasCompletionError } from "./types";

export type OpenAICompletionPrepareError = {
	message: string;
	status: number;
	code?: string;
	reason?: string;
};

export type PreparedOpenAICompletion = {
	rm: Extract<ResolvedModel, { name: string }>;
	structured: unknown;
	allTools: unknown[];
	tools: unknown[] | null;
	toolPolicy: ToolChoicePolicy;
	promptToolChoice: "none" | "required" | "auto";
	prompt: string;
	fileRefs: FileRef[] | null;
	promptTokens: number;
	contextFiles: ContextFileResult | null;
};

export type PrepareOpenAICompletionOptions = {
	emptyPromptMessage: string;
};

export async function prepareOpenAICompletion(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	req: LooseRequest,
	messages: unknown,
	toolsRaw: unknown,
	options: PrepareOpenAICompletionOptions,
): Promise<PreparedOpenAICompletion | { error: OpenAICompletionPrepareError }> {
	const rm = resolveModel(req.model, cfg.default_model);
	if (rm.name === undefined) {
		log(
			cfg,
			`openai completion model rejected model=${String(req.model ?? "(default)")}`,
		);
		return {
			error: { message: rm.error, status: 400, code: "model_not_found" },
		};
	}

	const structured = buildStructuredOutputRequirement(
		getStructuredResponseFormat(req),
	);
	if (structured?.error) {
		return {
			error: {
				message: structured.error,
				status: 400,
				code: "invalid_response_format",
			},
		};
	}

	const toolBundle = createToolBundle(toolsRaw);
	const toolPolicy = parseOpenAIToolChoicePolicy(
		req.tool_choice != null ? req.tool_choice : "auto",
		toolBundle,
	);
	if (toolPolicy.error)
		return {
			error: {
				message: toolPolicy.error,
				status: 400,
				code: "invalid_tool_choice",
			},
		};

	const filteredToolBundle = filterToolBundleByPolicy(toolBundle, toolPolicy);
	const allTools = toolBundle.openAIFunctionTools;
	const tools = filteredToolBundle.openAIFunctionTools.length
		? filteredToolBundle.openAIFunctionTools
		: null;
	let promptToolChoice: "auto" | "none" | "required" = "auto";
	if (toolPolicy.mode === "none") promptToolChoice = "none";
	else if (toolPolicy.mode === "required" || toolPolicy.mode === "forced")
		promptToolChoice = "required";
	const ctx = await prepareOpenAIGeminiContext(
		cfg,
		provider,
		req,
		messages,
		filteredToolBundle,
		promptToolChoice,
		toolPolicy,
		structured,
	);
	if (hasCompletionError(ctx)) {
		const code = upstreamErrorCode(ctx.error);
		const reason = upstreamErrorReason(ctx.error);
		const error: OpenAICompletionPrepareError = {
			message: upstreamErrorMessage(ctx.error),
			status: upstreamErrorStatus(ctx.error) || 502,
		};
		if (code) error.code = code;
		if (reason) error.reason = reason;
		return {
			error,
		};
	}
	let { prompt } = ctx;
	const { fileRefs, promptTokens, contextFiles } = ctx;
	let promptToolSource: unknown = [];
	if (toolPolicy.mode !== "none") {
		promptToolSource = filteredToolBundle.defs.length
			? filteredToolBundle
			: toolBundle;
	}
	prompt = ensureInlineToolPrompt(
		prompt,
		promptToolSource,
		buildToolChoiceInstructionFromPolicy(toolPolicy),
		contextFiles,
		ctx.promptMetadata,
	);
	if (!String(prompt || "").trim())
		return { error: { message: options.emptyPromptMessage, status: 400 } };

	return {
		rm,
		structured,
		allTools,
		tools,
		toolPolicy,
		promptToolChoice,
		prompt,
		fileRefs,
		promptTokens,
		contextFiles,
	};
}
