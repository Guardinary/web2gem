import type { RuntimeConfig } from "../config";
import type { ResolvedModelOk } from "../models";
import type { InternalMessage } from "../promptcompat/message-model";
import {
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
	upstreamErrorStatus,
} from "../shared/errors";
import { log } from "../shared/logging";
import {
	googleToolChoiceInstructionFromPolicy,
	parseGoogleToolChoicePolicy,
	validateGoogleToolChoiceConfig,
} from "../toolcall/policy-google";
import type {
	ToolChoicePolicy,
	ToolPolicyViolation,
} from "../toolcall/policy-openai";
import {
	buildToolChoiceInstructionFromPolicy,
	parseOpenAIToolChoicePolicy,
} from "../toolcall/policy-openai";
import {
	buildStructuredOutputRequirement,
	getStructuredResponseFormat,
} from "./structured-output";
import {
	createToolBundle,
	filterToolBundleByPolicy,
	type ToolBundle,
} from "../toolcall/tool-bundle";
import {
	prepareGoogleGeminiContext,
	prepareOpenAIGeminiContext,
} from "./context";
import { type CompletionProvider, resolveCompletionModel } from "./ports";
import { ensureInlineToolPrompt } from "./tool-prompt-guard";
import type {
	ContextFileResult,
	FileRef,
	GeminiContextPrepareResult,
	LooseRequest,
} from "./types";
import { hasCompletionError } from "./types";

export type CompletionPrepareError = {
	message: string;
	status: number;
	code?: string;
	reason?: string;
};

export type StructuredOutputRequirementResult = ReturnType<
	typeof buildStructuredOutputRequirement
>;

export type PromptToolChoice = "auto" | "none" | "required";

export type PreparedCompletion = {
	rm: ResolvedModelOk;
	bundle: ToolBundle;
	tools: ToolBundle | null;
	toolPolicy: ToolChoicePolicy;
	promptToolChoice: PromptToolChoice;
	structured: StructuredOutputRequirementResult;
	prompt: string;
	fileRefs: FileRef[] | null;
	promptTokens: number;
	contextFiles: ContextFileResult | null;
};

type PrepareContextArgs = {
	cfg: RuntimeConfig;
	provider: CompletionProvider;
	req: LooseRequest;
	messages: readonly InternalMessage[];
	bundle: ToolBundle;
	filtered: ToolBundle;
	toolPolicy: ToolChoicePolicy;
	promptToolChoice: PromptToolChoice;
	hasTools: boolean;
	choiceInstruction: string;
	structured: StructuredOutputRequirementResult;
};

export type CompletionDialect = {
	stage: "openai" | "google";
	modelLogLabel(model: unknown): string;
	structured(req: LooseRequest): StructuredOutputRequirementResult;
	validateToolConfig(
		req: LooseRequest,
		bundle: ToolBundle,
	): ToolPolicyViolation | null;
	parsePolicy(req: LooseRequest, bundle: ToolBundle): ToolChoicePolicy;
	choiceInstruction(policy: ToolChoicePolicy): string;
	emptyPromptMessage: string;
	defaultPrepareErrorCode: string | null;
	promptToolSource(
		bundle: ToolBundle,
		filtered: ToolBundle,
		policy: ToolChoicePolicy,
	): ToolBundle | null;
	prepareContext(args: PrepareContextArgs): Promise<GeminiContextPrepareResult>;
};

export const OPENAI_COMPLETION_DIALECT: CompletionDialect = {
	stage: "openai",
	modelLogLabel: (model) => String(model ?? "(default)"),
	structured: (req) =>
		buildStructuredOutputRequirement(getStructuredResponseFormat(req)),
	validateToolConfig: () => null,
	parsePolicy: (req, bundle) =>
		parseOpenAIToolChoicePolicy(
			req.tool_choice != null ? req.tool_choice : "auto",
			bundle,
		),
	choiceInstruction: (policy) => buildToolChoiceInstructionFromPolicy(policy),
	emptyPromptMessage: "empty prompt",
	defaultPrepareErrorCode: null,
	promptToolSource: (bundle, filtered, policy) => {
		if (policy.mode === "none") return null;
		return filtered.defs.length ? filtered : bundle;
	},
	prepareContext: (args) =>
		prepareOpenAIGeminiContext(
			args.cfg,
			args.provider,
			args.req,
			args.messages,
			args.filtered,
			args.promptToolChoice,
			args.toolPolicy,
			args.structured,
		),
};

export const GOOGLE_COMPLETION_DIALECT: CompletionDialect = {
	stage: "google",
	modelLogLabel: (model) => String(model || "(empty)"),
	structured: () => null,
	validateToolConfig: (req, bundle) =>
		validateGoogleToolChoiceConfig(req, bundle),
	parsePolicy: (req, bundle) => parseGoogleToolChoicePolicy(req, bundle),
	choiceInstruction: (policy) => googleToolChoiceInstructionFromPolicy(policy),
	emptyPromptMessage: "empty content",
	defaultPrepareErrorCode: "context_file_upload_failed",
	promptToolSource: (bundle, filtered) =>
		filtered.defs.length ? filtered : bundle,
	prepareContext: (args) =>
		prepareGoogleGeminiContext(
			args.cfg,
			args.provider,
			args.messages,
			args.hasTools,
			args.filtered,
			args.choiceInstruction,
		),
};

export type PrepareCompletionOptions = {
	emptyPromptMessage?: string;
};

export async function prepareCompletion(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	req: LooseRequest,
	messages: readonly InternalMessage[],
	model: unknown,
	dialect: CompletionDialect,
	options: PrepareCompletionOptions = {},
): Promise<PreparedCompletion | { error: CompletionPrepareError }> {
	const rm = await resolveCompletionModel(provider, model, cfg.default_model);
	if (rm.name === undefined) {
		log(
			cfg,
			`${dialect.stage} completion model rejected model=${dialect.modelLogLabel(model)}`,
		);
		return {
			error: { message: rm.error, status: 400, code: "model_not_found" },
		};
	}

	const structured = dialect.structured(req);
	if (structured?.error) {
		return {
			error: {
				message: structured.error,
				status: 400,
				code: "invalid_response_format",
			},
		};
	}

	const bundle = createToolBundle(req.tools);
	const toolConfigViolation = dialect.validateToolConfig(req, bundle);
	if (toolConfigViolation) {
		return {
			error: {
				message: toolConfigViolation.message,
				status: 400,
				code: "invalid_tool_choice",
			},
		};
	}
	const toolPolicy = dialect.parsePolicy(req, bundle);
	if (toolPolicy.error) {
		return {
			error: {
				message: toolPolicy.error,
				status: 400,
				code: "invalid_tool_choice",
			},
		};
	}

	const filtered = filterToolBundleByPolicy(bundle, toolPolicy);
	const tools = filtered.openAIFunctionTools.length ? filtered : null;
	let promptToolChoice: PromptToolChoice = "auto";
	if (toolPolicy.mode === "none") promptToolChoice = "none";
	else if (toolPolicy.mode === "required" || toolPolicy.mode === "forced")
		promptToolChoice = "required";
	const hasTools = !!tools && promptToolChoice !== "none";
	const choiceInstruction = dialect.choiceInstruction(toolPolicy);

	const ctx = await dialect.prepareContext({
		cfg,
		provider,
		req,
		messages,
		bundle,
		filtered,
		toolPolicy,
		promptToolChoice,
		hasTools,
		choiceInstruction,
		structured,
	});
	if (hasCompletionError(ctx)) {
		const code =
			upstreamErrorCode(ctx.error) || dialect.defaultPrepareErrorCode || "";
		const reason = upstreamErrorReason(ctx.error);
		const error: CompletionPrepareError = {
			message: upstreamErrorMessage(ctx.error),
			status: upstreamErrorStatus(ctx.error) || 502,
		};
		if (code) error.code = code;
		if (reason) error.reason = reason;
		return { error };
	}

	const prompt = ensureInlineToolPrompt(
		ctx.prompt,
		dialect.promptToolSource(bundle, filtered, toolPolicy),
		choiceInstruction,
		ctx.contextFiles,
		ctx.promptMetadata,
	);
	if (!String(prompt || "").trim()) {
		return {
			error: {
				message: options.emptyPromptMessage ?? dialect.emptyPromptMessage,
				status: 400,
			},
		};
	}

	return {
		rm,
		bundle,
		tools,
		toolPolicy,
		promptToolChoice,
		structured,
		prompt,
		fileRefs: ctx.fileRefs,
		promptTokens: ctx.promptTokens,
		contextFiles: ctx.contextFiles,
	};
}
