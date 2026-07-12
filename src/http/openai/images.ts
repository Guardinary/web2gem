import { jsonResponse } from "../core/json";
import type {
	CompletionProvider,
	CompletionRichOutput,
	GeneratedImage,
} from "../../completion/ports";
import {
	prepareOpenAIImageGenerationCompletion,
	prepareOpenAIImageGenerationFromUserInput,
} from "../../completion/image-generation";
import type { RuntimeConfig } from "../../config";
import { elapsedMs, log, logStage, nowMs, nowSec } from "../../shared/logging";
import { errorLogSummary, upstreamErrorCode } from "../../shared/errors";
import type { UnknownRecord } from "../../shared/types";
import { openAIErrorResponse, openAIUpstreamErrorResponse } from "./errors";
import {
	buildOpenAIImagesResponse,
	type OpenAIImagesResponseFormat,
} from "./format";
import {
	collectImageEditParts,
	parseImageEditMultipartRequest,
	parseImageEndpointBoolean,
} from "./images-input";

type ParsedImageEndpointOptions = {
	prompt: string;
	responseFormat: OpenAIImagesResponseFormat;
};

type ParsedImageEndpointResult =
	| ParsedImageEndpointOptions
	| { response: Response };

const IMAGE_ENDPOINT_ROUTE = "responses";

export async function handleImageGenerations(
	req: UnknownRecord,
	cfg: RuntimeConfig,
	provider: CompletionProvider,
): Promise<Response> {
	const parsed = parseImageEndpointOptions(req);
	if ("response" in parsed) return parsed.response;

	return handleForcedImageEndpoint(
		cfg,
		provider,
		{
			model: req.model,
			input: parsed.prompt,
		},
		parsed.responseFormat,
		"openai_images_generations",
	);
}

export async function handleImageEdits(
	req: UnknownRecord,
	cfg: RuntimeConfig,
	provider: CompletionProvider,
): Promise<Response> {
	const parsed = parseImageEndpointOptions(req);
	if ("response" in parsed) return parsed.response;

	const imageParts = collectImageEditParts(req);
	if (!imageParts.length) {
		return openAIErrorResponse(
			"image edits require at least one image input",
			400,
			"image_input_unsupported",
		);
	}

	return handleForcedImageEndpoint(
		cfg,
		provider,
		{
			model: req.model,
			input: [
				{
					role: "user",
					content: [{ type: "input_text", text: parsed.prompt }, ...imageParts],
				},
			],
		},
		parsed.responseFormat,
		"openai_images_edits",
	);
}

export async function handleImageEditsMultipart(
	request: Request,
	cfg: RuntimeConfig,
	provider: CompletionProvider,
): Promise<Response> {
	const parsedForm = await parseImageEditMultipartRequest(request, cfg);
	if ("response" in parsedForm) return parsedForm.response;

	const parsed = parseImageEndpointOptions(parsedForm.body);
	if ("response" in parsed) return parsed.response;
	if (!parsedForm.imageInputs.length) {
		return openAIErrorResponse(
			"image edits require at least one image input",
			400,
			"image_input_unsupported",
		);
	}

	return handleForcedImageEndpointFromUserInput(
		cfg,
		provider,
		{
			model: parsedForm.body.model,
			prompt: parsed.prompt,
			imageInputs: parsedForm.imageInputs,
		},
		parsed.responseFormat,
		"openai_images_edits_multipart",
	);
}

function parseImageEndpointOptions(
	req: UnknownRecord,
): ParsedImageEndpointResult {
	const stream = parseImageEndpointBoolean(req.stream);
	if ("response" in stream) return stream;
	if (stream.value === true) {
		return {
			response: openAIErrorResponse(
				"streaming image generation is not supported by this worker",
				400,
				"unsupported_image_generation_stream",
			),
		};
	}

	const countError = validateImageCount(req.n);
	if (countError) return { response: countError };

	const responseFormat = parseImagesResponseFormat(req.response_format);
	if ("response" in responseFormat) return responseFormat;

	const prompt = typeof req.prompt === "string" ? req.prompt.trim() : "";
	if (!prompt) {
		return {
			response: openAIErrorResponse(
				"image generation requires non-empty prompt text",
				400,
				"image_generation_empty_prompt",
			),
		};
	}

	return { prompt, responseFormat: responseFormat.responseFormat };
}

function validateImageCount(value: unknown): Response | null {
	if (value == null) return null;
	let count = Number.NaN;
	if (typeof value === "number") count = value;
	else if (typeof value === "string" && value.trim()) count = Number(value);
	if (!Number.isInteger(count) || count !== 1) {
		return openAIErrorResponse(
			"this worker supports only n=1 for image endpoint requests",
			400,
			"unsupported_image_count",
		);
	}
	return null;
}

function parseImagesResponseFormat(
	value: unknown,
): { responseFormat: OpenAIImagesResponseFormat } | { response: Response } {
	if (value == null) return { responseFormat: "b64_json" };
	const normalized = typeof value === "string" ? value.trim() : "";
	if (normalized === "b64_json" || normalized === "url")
		return { responseFormat: normalized };
	return {
		response: openAIErrorResponse(
			"response_format must be b64_json or url",
			400,
			"invalid_response_format",
		),
	};
}

async function handleForcedImageEndpoint(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	imageReq: UnknownRecord,
	responseFormat: OpenAIImagesResponseFormat,
	stagePrefix: string,
): Promise<Response> {
	return handlePreparedForcedImageEndpoint(
		cfg,
		provider,
		() =>
			prepareOpenAIImageGenerationCompletion(
				cfg,
				provider,
				imageReq,
				IMAGE_ENDPOINT_ROUTE,
				true,
			),
		responseFormat,
		stagePrefix,
	);
}

async function handleForcedImageEndpointFromUserInput(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	input: Parameters<typeof prepareOpenAIImageGenerationFromUserInput>[2],
	responseFormat: OpenAIImagesResponseFormat,
	stagePrefix: string,
): Promise<Response> {
	return handlePreparedForcedImageEndpoint(
		cfg,
		provider,
		() => prepareOpenAIImageGenerationFromUserInput(cfg, provider, input, true),
		responseFormat,
		stagePrefix,
	);
}

async function handlePreparedForcedImageEndpoint(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	prepare: () => ReturnType<typeof prepareOpenAIImageGenerationCompletion>,
	responseFormat: OpenAIImagesResponseFormat,
	stagePrefix: string,
): Promise<Response> {
	if (!provider.generateRich) {
		return openAIErrorResponse(
			"configured completion provider does not support image generation",
			502,
			"image_generation_provider_unsupported",
		);
	}

	const logRequests = !!cfg.log_requests;
	const prepareStart = logRequests ? nowMs() : 0;
	const prepared = await prepare();
	if ("error" in prepared) {
		await provider.dispose?.();
		if (logRequests)
			logStage(cfg, `${stagePrefix}_prepare`, {
				ms: elapsedMs(prepareStart),
				status: prepared.error.status,
				code: prepared.error.code,
			});
		return openAIErrorResponse(
			prepared.error.message,
			prepared.error.status,
			prepared.error.code,
			prepared.error.reason,
		);
	}

	const { rm, prompt, fileRefs, promptTokens } = prepared;
	if (logRequests) {
		logStage(cfg, `${stagePrefix}_prepare`, {
			ms: elapsedMs(prepareStart),
			status: 200,
			model: rm.name,
			promptChars: prompt.length,
			promptTokens,
			fileRefs: fileRefs ? fileRefs.length : 0,
		});
	}

	const generationStart = logRequests ? nowMs() : 0;
	let rich: CompletionRichOutput;
	try {
		rich = await provider.generateRich(
			{ prompt, rm, fileRefs },
			{
				hydrateGeneratedImageBytes: responseFormat === "b64_json",
			},
		);
	} catch (e) {
		if (logRequests)
			logStage(cfg, `${stagePrefix}_generate`, {
				ms: elapsedMs(generationStart),
				status: "error",
				model: rm.name,
			});
		log(
			cfg,
			`${stagePrefix} generate failed model=${rm.name} code=${upstreamErrorCode(e) || "upstream_error"} error=${errorLogSummary(e)}`,
		);
		return openAIUpstreamErrorResponse(e);
	}

	if (logRequests) {
		logStage(cfg, `${stagePrefix}_generate`, {
			ms: elapsedMs(generationStart),
			status: "ok",
			model: rm.name,
			completionChars: rich.text.length,
			images: rich.images.length,
			promptTokens,
			fileRefs: fileRefs ? fileRefs.length : 0,
		});
	}

	const generatedImages = rich.images.filter(
		(image) => image.source === "generated",
	);
	if (!generatedImages.length) {
		return openAIErrorResponse(
			"Gemini returned no usable generated image",
			502,
			"upstream_image_generation_empty",
		);
	}

	const usableImages = usableEndpointImages(generatedImages, responseFormat);
	if (!usableImages.length) {
		const code =
			responseFormat === "b64_json"
				? "upstream_image_fetch_failed"
				: "upstream_image_generation_empty";
		const message =
			responseFormat === "b64_json"
				? "Gemini returned generated image metadata but no validated image bytes"
				: "Gemini returned generated images without usable URLs";
		return openAIErrorResponse(message, 502, code);
	}

	return jsonResponse(
		buildOpenAIImagesResponse(usableImages, {
			created: nowSec(),
			responseFormat,
		}),
	);
}

function usableEndpointImages(
	images: readonly GeneratedImage[],
	responseFormat: OpenAIImagesResponseFormat,
): GeneratedImage[] {
	if (responseFormat === "url") return images.filter((image) => !!image.url);
	return images.filter((image) => !!(image.base64 && image.outputFormat));
}
