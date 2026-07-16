import { isRecord, type UnknownRecord } from "../../shared/types";
import type {
	CompletionProvider,
	CompletionRichOutput,
} from "../../completion/ports";
import { prepareOpenAIImageGenerationCompletion } from "../../completion/image-generation";
import type { RuntimeConfig } from "../../config";
import type { ResolvedModelOk } from "../../models";
import type { InternalMessage } from "../../promptcompat/message-model";
import { generateRichLogged, runPreparedCompletion } from "../generation";
import { OPENAI_GENERATION_PROTOCOL, openAIErrorResponse } from "./errors";

export type ImageGenerationMode = {
	enabled: boolean;
	forced: boolean;
	tool: UnknownRecord | null;
};

export function imageGenerationMode(req: UnknownRecord): ImageGenerationMode {
	const choice = isRecord(req.tool_choice) ? req.tool_choice : null;
	if (choice && choice.type === "image_generation") {
		return { enabled: true, forced: true, tool: choice };
	}
	const tools = Array.isArray(req.tools) ? req.tools : [];
	for (const tool of tools) {
		if (isRecord(tool) && tool.type === "image_generation") {
			return { enabled: true, forced: false, tool };
		}
	}
	return { enabled: false, forced: false, tool: null };
}

export function isImageGenerationRequest(req: UnknownRecord): boolean {
	return imageGenerationMode(req).enabled;
}

// Shared runner for the chat and responses image-generation branches. Both
// prepare identically and validate rich output identically; only the final
// payload shaping differs, supplied by `format`.
export async function runImageGenerationCompletion(args: {
	req: UnknownRecord;
	cfg: RuntimeConfig;
	provider: CompletionProvider;
	route: "chat" | "responses";
	messages: readonly InternalMessage[];
	forced: boolean;
	stage: string;
	logLabel: string;
	format: (
		rich: CompletionRichOutput,
		promptTokens: number,
		rm: ResolvedModelOk,
	) => Response;
}): Promise<Response> {
	const { req, cfg, provider } = args;
	if (req.stream)
		return openAIErrorResponse(
			"streaming image generation is not supported by this worker",
			400,
			"unsupported_image_generation_stream",
		);
	if (!provider.generateRich) {
		return openAIErrorResponse(
			"configured completion provider does not support image generation",
			502,
			"image_generation_provider_unsupported",
		);
	}
	return runPreparedCompletion({
		cfg,
		provider,
		stage: args.stage,
		protocol: OPENAI_GENERATION_PROTOCOL,
		prepare: () =>
			prepareOpenAIImageGenerationCompletion(
				cfg,
				provider,
				req,
				args.route,
				args.forced,
				args.messages,
			),
		prepareLogFields: (prepared) => ({
			model: prepared.rm.name,
			promptChars: prepared.prompt.length,
			promptTokens: prepared.promptTokens,
			fileRefs: prepared.fileRefs ? prepared.fileRefs.length : 0,
		}),
		run: async (prepared, stageLog) => {
			const { rm, prompt, fileRefs, promptTokens } = prepared;
			const generated = await generateRichLogged({
				cfg,
				provider,
				stage: args.stage,
				logLabel: args.logLabel,
				protocol: OPENAI_GENERATION_PROTOCOL,
				stageLog,
				input: { prompt, rm, fileRefs },
				forced: args.forced,
				validate: "imageOutput",
				okLogFields: (rich) => ({
					completionChars: rich.text.length,
					images: rich.images.length,
					promptTokens,
					fileRefs: fileRefs ? fileRefs.length : 0,
				}),
			});
			if (generated.response) return generated.response;
			return args.format(generated.rich, promptTokens, rm);
		},
	});
}
