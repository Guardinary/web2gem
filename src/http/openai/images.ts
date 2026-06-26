import { jsonResponse } from "../core/json";
import type { CompletionProvider, CompletionRichOutput, GeneratedImage } from "../../completion/ports";
import { prepareOpenAIImageGenerationCompletion, prepareOpenAIImageGenerationFromUserInput, type ImageGenerationByteInput, type ImageGenerationUserImageInput } from "../../completion/image-generation";
import { MAX_ATTACHMENTS_PER_REQUEST } from "../../attachments/plan";
import { readRequestBodyBytes } from "../core/json";
import type { RuntimeConfig } from "../../config";
import { elapsedMs, errorLogSummary, log, logStage, nowMs, nowSec, upstreamErrorCode } from "../../shared/runtime";
import { isRecord, type UnknownRecord } from "../../shared/types";
import { openAIErrorResponse, openAIUpstreamErrorResponse } from "./errors";
import { buildOpenAIImagesResponse, type OpenAIImagesResponseFormat } from "./format";

type ParsedImageEndpointOptions = {
  prompt: string;
  responseFormat: OpenAIImagesResponseFormat;
};

type ParsedImageEndpointResult =
  | ParsedImageEndpointOptions
  | { response: Response };

const IMAGE_ENDPOINT_ROUTE = "responses";
const MULTIPART_IMAGE_FIELD_NAMES = new Set(["image", "image[]", "images", "images[]", "image_url", "image_url[]", "input_image", "input_image[]"]);
const MULTIPART_FORM_OVERHEAD_BYTES = 1024 * 1024;

export async function handleImageGenerations(req: UnknownRecord, cfg: RuntimeConfig, provider: CompletionProvider): Promise<Response> {
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

export async function handleImageEdits(req: UnknownRecord, cfg: RuntimeConfig, provider: CompletionProvider): Promise<Response> {
  const parsed = parseImageEndpointOptions(req);
  if ("response" in parsed) return parsed.response;

  const imageParts = collectImageEditParts(req);
  if (!imageParts.length) {
    return openAIErrorResponse("image edits require at least one image input", 400, "image_input_unsupported");
  }

  return handleForcedImageEndpoint(
    cfg,
    provider,
    {
      model: req.model,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: parsed.prompt },
          ...imageParts,
        ],
      }],
    },
    parsed.responseFormat,
    "openai_images_edits",
  );
}

export async function handleImageEditsMultipart(request: Request, cfg: RuntimeConfig, provider: CompletionProvider): Promise<Response> {
  const parsedForm = await parseImageEditMultipartRequest(request, cfg);
  if ("response" in parsedForm) return parsedForm.response;

  const parsed = parseImageEndpointOptions(parsedForm.body);
  if ("response" in parsed) return parsed.response;
  if (!parsedForm.imageInputs.length) {
    return openAIErrorResponse("image edits require at least one image input", 400, "image_input_unsupported");
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

function parseImageEndpointOptions(req: UnknownRecord): ParsedImageEndpointResult {
  const stream = parseImageEndpointBoolean(req.stream);
  if ("response" in stream) return stream;
  if (stream.value === true) {
    return {
      response: openAIErrorResponse("streaming image generation is not supported by this worker", 400, "unsupported_image_generation_stream"),
    };
  }

  const countError = validateImageCount(req.n);
  if (countError) return { response: countError };

  const responseFormat = parseImagesResponseFormat(req.response_format);
  if ("response" in responseFormat) return responseFormat;

  const prompt = typeof req.prompt === "string" ? req.prompt.trim() : "";
  if (!prompt) {
    return {
      response: openAIErrorResponse("image generation requires non-empty prompt text", 400, "image_generation_empty_prompt"),
    };
  }

  return { prompt, responseFormat: responseFormat.responseFormat };
}

function validateImageCount(value: unknown): Response | null {
  if (value == null) return null;
  const count = typeof value === "number" ? value : (typeof value === "string" && value.trim() ? Number(value) : NaN);
  if (!Number.isInteger(count) || count !== 1) {
    return openAIErrorResponse("this worker supports only n=1 for image endpoint requests", 400, "unsupported_image_count");
  }
  return null;
}

function parseImagesResponseFormat(value: unknown): { responseFormat: OpenAIImagesResponseFormat } | { response: Response } {
  if (value == null) return { responseFormat: "b64_json" };
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "b64_json" || normalized === "url") return { responseFormat: normalized };
  return {
    response: openAIErrorResponse("response_format must be b64_json or url", 400, "invalid_response_format"),
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
    () => prepareOpenAIImageGenerationCompletion(cfg, provider, imageReq, IMAGE_ENDPOINT_ROUTE, true),
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
    return openAIErrorResponse("configured completion provider does not support image generation", 502, "image_generation_provider_unsupported");
  }

  const logRequests = !!cfg.log_requests;
  const prepareStart = logRequests ? nowMs() : 0;
  const prepared = await prepare();
  if ("error" in prepared) {
    if (logRequests) logStage(cfg, `${stagePrefix}_prepare`, { ms: elapsedMs(prepareStart), status: prepared.error.status, code: prepared.error.code });
    return openAIErrorResponse(prepared.error.message, prepared.error.status, prepared.error.code);
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
    rich = await provider.generateRich({ prompt, rm, fileRefs });
  } catch (e) {
    if (logRequests) logStage(cfg, `${stagePrefix}_generate`, { ms: elapsedMs(generationStart), status: "error", model: rm.name });
    log(cfg, `${stagePrefix} generate failed model=${rm.name} code=${upstreamErrorCode(e) || "upstream_error"} error=${errorLogSummary(e)}`);
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

  const generatedImages = rich.images.filter((image) => image.source === "generated");
  if (!generatedImages.length) {
    return openAIErrorResponse("Gemini returned no usable generated image", 502, "upstream_image_generation_empty");
  }

  const usableImages = usableEndpointImages(generatedImages, responseFormat);
  if (!usableImages.length) {
    const code = responseFormat === "b64_json" ? "upstream_image_fetch_failed" : "upstream_image_generation_empty";
    const message = responseFormat === "b64_json"
      ? "Gemini returned generated image metadata but no validated image bytes"
      : "Gemini returned generated images without usable URLs";
    return openAIErrorResponse(message, 502, code);
  }

  return jsonResponse(buildOpenAIImagesResponse(usableImages, {
    created: nowSec(),
    responseFormat,
  }));
}

function usableEndpointImages(images: readonly GeneratedImage[], responseFormat: OpenAIImagesResponseFormat): GeneratedImage[] {
  if (responseFormat === "url") return images.filter((image) => !!image.url);
  return images.filter((image) => !!(image.base64 && image.outputFormat));
}

function collectImageEditParts(req: UnknownRecord): UnknownRecord[] {
  const parts: UnknownRecord[] = [];
  appendImageInputValue(parts, req.image);
  appendImageInputValue(parts, req.images);
  appendImageInputValue(parts, req.image_url);
  appendImageInputValue(parts, req.input_image);
  return parts;
}

type ParsedImageEditMultipartRequest = {
  body: UnknownRecord;
  imageInputs: ImageGenerationUserImageInput[];
};

async function parseImageEditMultipartRequest(request: Request, cfg: RuntimeConfig): Promise<ParsedImageEditMultipartRequest | { response: Response }> {
  const maxBodyBytes = multipartImageEditBodyLimit(cfg);
  const read = await readRequestBodyBytes(request, {
    maxBodyBytes,
    oversizedError: {
      message: `multipart image edit request body is too large (${maxBodyBytes} byte limit)`,
      status: 413,
      code: "image_input_too_large",
    },
  });
  if (read.error !== undefined) return { response: openAIErrorResponse(read.error, read.status, read.code) };

  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: read.value,
    }).formData();
  } catch (_) {
    return { response: openAIErrorResponse("invalid multipart form data", 400, "invalid_multipart_form") };
  }

  const bodyResult = imageEditBodyFromForm(form);
  if ("response" in bodyResult) return bodyResult;

  const imageInputs: ImageGenerationUserImageInput[] = [];
  for (const [key, value] of form.entries()) {
    if (!MULTIPART_IMAGE_FIELD_NAMES.has(key)) continue;
    if (typeof value === "string") {
      appendMultipartImageText(imageInputs, value);
      continue;
    }
    const appended = await appendMultipartImageFile(imageInputs, value, cfg);
    if ("response" in appended) return appended;
  }

  return { body: bodyResult.body, imageInputs };
}

function multipartImageEditBodyLimit(cfg: RuntimeConfig): number {
  const configured = Math.max(0, Math.floor(Number(cfg.generic_file_upload_max_bytes) || 0));
  return configured + MULTIPART_FORM_OVERHEAD_BYTES;
}

function imageEditBodyFromForm(form: FormData): { body: UnknownRecord } | { response: Response } {
  const body: UnknownRecord = {};
  const prompt = formStringValue(form, "prompt");
  if (prompt !== undefined) body.prompt = prompt;
  const model = formStringValue(form, "model");
  if (model !== undefined) body.model = model;
  const n = formStringValue(form, "n");
  if (n !== undefined) body.n = n;
  const size = formStringValue(form, "size");
  if (size !== undefined) body.size = size;
  const responseFormat = formStringValue(form, "response_format");
  if (responseFormat !== undefined) body.response_format = responseFormat;

  const streamValue = formStringValue(form, "stream");
  const stream = parseImageEndpointBoolean(streamValue);
  if ("response" in stream) return stream;
  if (stream.value !== undefined) body.stream = stream.value;

  return { body };
}

function formStringValue(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

function parseImageEndpointBoolean(value: unknown): { value: boolean | undefined } | { response: Response } {
  if (value == null) return { value: undefined };
  if (typeof value === "boolean") return { value };
  if (typeof value === "number") {
    if (value === 1) return { value: true };
    if (value === 0) return { value: false };
    return { response: openAIErrorResponse("stream must be a boolean", 400, "invalid_request") };
  }
  if (typeof value !== "string") {
    return { response: openAIErrorResponse("stream must be a boolean", 400, "invalid_request") };
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) return { value: undefined };
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return { value: true };
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return { value: false };
  return { response: openAIErrorResponse("stream must be a boolean", 400, "invalid_request") };
}

function appendMultipartImageText(inputs: ImageGenerationUserImageInput[], value: string): void {
  const parsed = parseMultipartImageReferenceText(value);
  const parts: UnknownRecord[] = [];
  appendImageInputValue(parts, parsed);
  for (const part of parts) inputs.push({ type: "part", part });
}

function parseMultipartImageReferenceText(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (_) {
    return value;
  }
}

async function appendMultipartImageFile(inputs: ImageGenerationUserImageInput[], file: File, cfg: RuntimeConfig): Promise<{ ok: true } | { response: Response }> {
  if (inputs.length >= MAX_ATTACHMENTS_PER_REQUEST) {
    return { response: openAIErrorResponse(`image generation supports at most ${MAX_ATTACHMENTS_PER_REQUEST} user attachments`, 400, "image_input_unsupported") };
  }

  const maxBytes = Math.max(0, Math.floor(Number(cfg.generic_file_upload_max_bytes) || 0));
  if (Number.isFinite(file.size) && file.size > maxBytes) {
    return { response: openAIErrorResponse(`image input is too large (${file.size} bytes > ${maxBytes})`, 413, "image_input_too_large") };
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (_) {
    return { response: openAIErrorResponse("failed to read multipart image file", 400, "image_input_unsupported") };
  }
  if (bytes.byteLength > maxBytes) {
    return { response: openAIErrorResponse(`image input is too large (${bytes.byteLength} bytes > ${maxBytes})`, 413, "image_input_too_large") };
  }

  const input: ImageGenerationByteInput = { bytes };
  if (file.name) input.filename = file.name;
  if (file.type) input.mime = file.type;
  inputs.push({ type: "bytes", image: input });
  return { ok: true };
}

function appendImageInputValue(parts: UnknownRecord[], value: unknown): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendImageInputValue(parts, item);
    return;
  }
  parts.push(normalizeImageInputPart(value));
}

function normalizeImageInputPart(value: unknown): UnknownRecord {
  if (typeof value === "string") return imagePartFromString(value);
  if (!isRecord(value)) {
    return {
      type: "input_image",
      source: { data: String(value ?? ""), media_type: "image/png" },
    };
  }

  const b64 = firstPresent(value.b64_json, value.base64, value.b64, value.data);
  if (b64 != null) {
    if (typeof b64 === "string" && isUrlLikeImageInput(b64)) {
      return {
        ...value,
        type: "input_image",
        image_url: b64,
      };
    }
    return {
      ...value,
      type: "input_image",
      source: { data: b64 },
    };
  }

  const urlValue = rawUrlValue(firstPresent(value.image_url, value.url));
  if (typeof urlValue === "string" && urlValue.trim() && !isUrlLikeImageInput(urlValue)) {
    return {
      ...value,
      type: "input_image",
      source: { data: urlValue, media_type: "image/png" },
    };
  }

  return { ...value, type: "input_image" };
}

function imagePartFromString(value: string): UnknownRecord {
  const trimmed = value.trim();
  if (isUrlLikeImageInput(trimmed)) return { type: "input_image", image_url: trimmed };
  return { type: "input_image", source: { data: trimmed, media_type: "image/png" } };
}

function rawUrlValue(value: unknown): unknown {
  return isRecord(value) ? value.url : value;
}

function isUrlLikeImageInput(value: string): boolean {
  return /^data:/i.test(value.trim()) || /^https?:\/\//i.test(value.trim());
}

function firstPresent(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}
