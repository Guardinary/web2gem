import type { CompletionProvider } from "../../completion";
import {
	finalizeOpenAICompletionResult,
	type OpenAICompletionTurn,
	type OpenAICompletionTurnOptions,
} from "../../completion/turn";
import type { RuntimeConfig } from "../../config";
import type { CompletionTextInput } from "../../completion/ports";
import {
	generateTextLogged,
	type GenerationProtocol,
	type StageLog,
} from "../generation";
import { openAIErrorResponse, OPENAI_GENERATION_PROTOCOL } from "./errors";
import { log } from "../../shared/logging";

type OpenAICompletionSuccess = Extract<OpenAICompletionTurn, { text: string }>;

export type OpenAICompletionTailResult =
	| { turn: OpenAICompletionSuccess; response?: undefined }
	| { response: Response; turn?: undefined };

export async function generateOpenAICompletionTail(args: {
	cfg: RuntimeConfig;
	provider: CompletionProvider;
	stage: string;
	logLabel: string;
	protocol?: GenerationProtocol;
	stageLog: StageLog;
	input: CompletionTextInput & { rm: { name: string } };
	options: OpenAICompletionTurnOptions;
	okLogFields: (text: string) => Record<string, unknown>;
}): Promise<OpenAICompletionTailResult> {
	const generated = await generateTextLogged({
		cfg: args.cfg,
		provider: args.provider,
		stage: args.stage,
		logLabel: args.logLabel,
		protocol: args.protocol || OPENAI_GENERATION_PROTOCOL,
		stageLog: args.stageLog,
		input: args.input,
		okLogFields: args.okLogFields,
	});
	if (generated.response) return generated;

	const finalized = finalizeOpenAICompletionResult(
		generated.text,
		args.options,
	);
	if (finalized.error) {
		if (finalized.error.code === "upstream_empty")
			log(
				args.cfg,
				`${args.logLabel} generate produced no content model=${args.input.rm.name}`,
			);
		return {
			response: openAIErrorResponse(
				finalized.error.message,
				finalized.error.status,
				finalized.error.code,
			),
		};
	}
	return { turn: finalized };
}
