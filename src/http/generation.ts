import type {
	CompletionProvider,
	CompletionRichOutput,
	CompletionRichOptions,
	CompletionTextInput,
} from "../completion/ports";
import type { RuntimeConfig } from "../config";
import { errorLogSummary, upstreamErrorCode } from "../shared/errors";
import { elapsedMs, log, logStage, nowMs } from "../shared/logging";

export type GenerationErrorShape = {
	message: unknown;
	status: number;
	code?: unknown;
	reason?: unknown;
};

// Per-protocol response shaping; adapters pass their constant in so this
// module stays independent of both protocol adapters.
export type GenerationProtocol = {
	errorResponse: (error: GenerationErrorShape) => Response;
	upstreamErrorResponse: (e: unknown) => Response;
};

export type StageLog = {
	enabled: boolean;
	now: () => number;
	log: (
		stage: string,
		startMs: number,
		fields: Record<string, unknown>,
	) => void;
};

function createStageLog(cfg: RuntimeConfig): StageLog {
	const enabled = !!cfg.log_requests;
	return {
		enabled,
		now: () => (enabled ? nowMs() : 0),
		log: (stage, startMs, fields) => {
			if (!enabled) return;
			logStage(cfg, stage, { ms: elapsedMs(startMs), ...fields });
		},
	};
}

type PrepareError = { error: GenerationErrorShape };

export type PreparedOk<P> = Exclude<P, PrepareError>;

function isPrepareError(prepared: object): prepared is PrepareError {
	return "error" in prepared && prepared.error !== undefined;
}

// Shared prepare orchestration: timing, dispose-on-error, prepare logStage
// (error and success), then delegation to the endpoint-specific run.
export async function runPreparedCompletion<P extends object>(args: {
	cfg: RuntimeConfig;
	provider: CompletionProvider;
	stage: string;
	protocol: GenerationProtocol;
	prepare: () => Promise<P>;
	prepareLogFields: (prepared: PreparedOk<P>) => Record<string, unknown>;
	run: (
		prepared: PreparedOk<P>,
		stageLog: StageLog,
	) => Promise<Response> | Response;
}): Promise<Response> {
	const stageLog = createStageLog(args.cfg);
	const prepareStart = stageLog.now();
	const prepared = await args.prepare();
	if (isPrepareError(prepared)) {
		await args.provider.dispose?.();
		stageLog.log(`${args.stage}_prepare`, prepareStart, {
			status: prepared.error.status,
			code: prepared.error.code,
		});
		return args.protocol.errorResponse(prepared.error);
	}
	const ok = prepared as PreparedOk<P>;
	stageLog.log(`${args.stage}_prepare`, prepareStart, {
		status: 200,
		...args.prepareLogFields(ok),
	});
	return args.run(ok, stageLog);
}

// Shared non-streaming text generation: try/catch, error+ok stage logs, the
// "<label> generate failed" log line, and the protocol upstream response.
export async function generateTextLogged(args: {
	cfg: RuntimeConfig;
	provider: CompletionProvider;
	stage: string;
	logLabel: string;
	protocol: GenerationProtocol;
	stageLog: StageLog;
	input: CompletionTextInput & { rm: { name: string } };
	errorLogFields?: (e: unknown) => Record<string, unknown>;
	okLogFields: (text: string) => Record<string, unknown>;
}): Promise<{ text: string; response?: undefined } | { response: Response }> {
	const { stageLog, input } = args;
	const generationStart = stageLog.now();
	let text: string;
	try {
		text = await args.provider.generateText(input);
	} catch (e) {
		stageLog.log(`${args.stage}_generate`, generationStart, {
			status: "error",
			model: input.rm.name,
			...(args.errorLogFields ? args.errorLogFields(e) : {}),
		});
		log(
			args.cfg,
			`${args.logLabel} generate failed model=${input.rm.name} code=${upstreamErrorCode(e) || "upstream_error"} error=${errorLogSummary(e)}`,
		);
		return { response: args.protocol.upstreamErrorResponse(e) };
	}
	stageLog.log(`${args.stage}_generate`, generationStart, {
		status: "ok",
		model: input.rm.name,
		...args.okLogFields(text),
	});
	return { text };
}

// Shared rich (image) generation with the same logging contract, plus the
// empty-output / forced-image validation used by the chat and responses
// image-generation routes ("imageOutput"); the dedicated images endpoints
// run their own response_format-aware validation instead ("none").
export async function generateRichLogged(args: {
	cfg: RuntimeConfig;
	provider: CompletionProvider;
	stage: string;
	logLabel: string;
	protocol: GenerationProtocol;
	stageLog: StageLog;
	input: CompletionTextInput & { rm: { name: string } };
	richOptions?: CompletionRichOptions;
	forced: boolean;
	validate: "imageOutput" | "none";
	okLogFields: (rich: CompletionRichOutput) => Record<string, unknown>;
}): Promise<
	{ rich: CompletionRichOutput; response?: undefined } | { response: Response }
> {
	const { stageLog, input } = args;
	const generateRich = args.provider.generateRich;
	if (!generateRich) {
		return {
			response: args.protocol.errorResponse({
				message:
					"configured completion provider does not support image generation",
				status: 502,
				code: "image_generation_provider_unsupported",
			}),
		};
	}
	const generationStart = stageLog.now();
	let rich: CompletionRichOutput;
	try {
		rich = await generateRich(input, args.richOptions);
	} catch (e) {
		stageLog.log(`${args.stage}_generate`, generationStart, {
			status: "error",
			model: input.rm.name,
		});
		log(
			args.cfg,
			`${args.logLabel} generate failed model=${input.rm.name} code=${upstreamErrorCode(e) || "upstream_error"} error=${errorLogSummary(e)}`,
		);
		return { response: args.protocol.upstreamErrorResponse(e) };
	}
	if (args.validate === "imageOutput") {
		if (!String(rich.text || "").trim() && !rich.images.length) {
			return {
				response: args.protocol.errorResponse({
					message: "Gemini returned empty image generation output",
					status: 502,
					code: "upstream_image_generation_empty",
				}),
			};
		}
		if (
			args.forced &&
			!rich.images.some((image) => image.source === "generated")
		) {
			return {
				response: args.protocol.errorResponse({
					message: "Gemini returned no usable generated image",
					status: 502,
					code: "upstream_image_generation_empty",
				}),
			};
		}
	}
	stageLog.log(`${args.stage}_generate`, generationStart, {
		status: "ok",
		model: input.rm.name,
		...args.okLogFields(rich),
	});
	return { rich };
}
