import { base64ToBytes } from "../attachments/base64";
import {
	detectUploadMimeFromBytes,
	firstNonEmptyString,
	imageFilenameFromMime,
	normalizeMimeType,
	sanitizeUploadFilename,
} from "../attachments/mime";
import {
	imageFilenameFromObject,
	normalizeUploadFileInput,
	parseImageUrl,
	uploadFilenameFromObject,
	uploadMimeFromObject,
} from "../attachments/input";
import { MAX_ATTACHMENTS_PER_REQUEST } from "../attachments/plan";
import type {
	AttachmentCandidate,
	AttachmentFileRef,
	AttachmentPlan,
} from "../attachments/types";
import type { RuntimeConfig } from "../config";
import { resolveModel, type ResolvedModel } from "../models";
import { log } from "../shared/logging";
import {
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
	upstreamErrorStatus,
} from "../shared/errors";
import { firstRecord, isRecord, type UnknownRecord } from "../shared/types";
import { promptByteLength, tokenEst } from "../shared/tokens";
import { contextFileThreshold } from "./context-files";
import { geminiAuthenticatedSessionRequiredError } from "../shared/errors";
import type { CompletionProvider } from "./ports";
import type {
	AttachmentResolutionResult,
	FileRef,
	LooseRequest,
} from "./types";

export type ImageGenerationPrepareError = {
	message: string;
	status: number;
	code: string;
	reason?: string;
};

export type PreparedImageGenerationCompletion = {
	rm: Extract<ResolvedModel, { name: string }>;
	prompt: string;
	userPrompt: string;
	fileRefs: FileRef[] | null;
	promptTokens: number;
};

export type ImageGenerationRouteKind = "responses" | "chat";

export type ImageGenerationByteInput = {
	bytes: Uint8Array;
	filename?: string;
	mime?: string;
};

export type ImageGenerationUserImageInput =
	| { type: "part"; part: UnknownRecord }
	| { type: "bytes"; image: ImageGenerationByteInput };

export type OpenAIImageGenerationUserInput = {
	model?: unknown;
	prompt: unknown;
	imageInputs?: readonly ImageGenerationUserImageInput[];
	imageParts?: readonly UnknownRecord[];
	imageBytes?: readonly ImageGenerationByteInput[];
};

type FileSlot =
	| { type: "existing"; ref: AttachmentFileRef }
	| { type: "candidate"; index: number };

type ExtractionState = {
	textParts: string[];
	candidates: AttachmentCandidate[];
	slots: FileSlot[];
	error: ImageGenerationPrepareError | null;
	nextID: number;
};

const IMAGE_GENERATION_INSTRUCTION = [
	"IMAGE GENERATION ENABLED: Return a real generated image matching the user's request.",
	"For edits to attached images, apply the requested changes and return a new generated version.",
	"Do not provide explanations, process notes, placeholders, or apologies without an actual generated image attachment.",
].join("\n");

const FORCED_IMAGE_GENERATION_INSTRUCTION =
	"Image generation was explicitly requested. Return at least one generated image; a response without a generated image is a failure.";

export async function prepareOpenAIImageGenerationCompletion(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	req: LooseRequest,
	route: ImageGenerationRouteKind,
	forced: boolean,
): Promise<
	PreparedImageGenerationCompletion | { error: ImageGenerationPrepareError }
> {
	const state = createExtractionState();
	if (route === "responses") extractResponsesUserInput(state, req.input);
	else extractLatestChatUserInput(state, req.messages);
	return prepareImageGenerationFromState(
		cfg,
		provider,
		req.model,
		state,
		forced,
	);
}

export async function prepareOpenAIImageGenerationFromUserInput(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	input: OpenAIImageGenerationUserInput,
	forced: boolean,
): Promise<
	PreparedImageGenerationCompletion | { error: ImageGenerationPrepareError }
> {
	const state = createExtractionState();
	appendText(state, input.prompt);
	if (input.imageInputs) {
		for (const imageInput of input.imageInputs) {
			if (state.error) break;
			if (imageInput.type === "part") appendImagePart(state, imageInput.part);
			else appendImageBytes(state, imageInput.image);
		}
	} else if (input.imageParts) {
		for (const part of input.imageParts) {
			if (state.error) break;
			appendImagePart(state, part);
		}
	}
	if (!input.imageInputs && input.imageBytes) {
		for (const image of input.imageBytes) {
			if (state.error) break;
			appendImageBytes(state, image);
		}
	}
	return prepareImageGenerationFromState(
		cfg,
		provider,
		input.model,
		state,
		forced,
	);
}

async function prepareImageGenerationFromState(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	model: unknown,
	state: ExtractionState,
	forced: boolean,
): Promise<
	PreparedImageGenerationCompletion | { error: ImageGenerationPrepareError }
> {
	if (!provider.supportsAuthenticatedSession) {
		const error = geminiAuthenticatedSessionRequiredError("image");
		const preparedError: ImageGenerationPrepareError = {
			message: error.message,
			status: error.status || 422,
			code: error.code || "gemini_authenticated_session_required",
		};
		if (error.reason) preparedError.reason = error.reason;
		return {
			error: preparedError,
		};
	}

	const rm = resolveModel(model, cfg.default_model);
	if (rm.name === undefined) {
		log(
			cfg,
			`openai image generation model rejected model=${String(model ?? "(default)")}`,
		);
		return {
			error: { message: rm.error, status: 400, code: "model_not_found" },
		};
	}

	if (state.error) return { error: state.error };

	const userPrompt = state.textParts
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
	if (!userPrompt) {
		return {
			error: {
				message: "image generation requires non-empty user prompt text",
				status: 400,
				code: "image_generation_empty_prompt",
			},
		};
	}

	const prompt = [
		userPrompt,
		IMAGE_GENERATION_INSTRUCTION,
		forced ? FORCED_IMAGE_GENERATION_INSTRUCTION : "",
	]
		.filter(Boolean)
		.join("\n\n");
	const promptBytes = promptByteLength(prompt);
	const threshold = contextFileThreshold(cfg);
	if (promptBytes > threshold) {
		return {
			error: {
				message: `image generation prompt is too large for pass-through mode (${promptBytes} UTF-8 bytes > ${threshold})`,
				status: 413,
				code: "image_generation_prompt_too_large",
			},
		};
	}

	const fileRefsResult = await resolveImageGenerationFileRefs(provider, state);
	if ("error" in fileRefsResult) return fileRefsResult;

	return {
		rm,
		prompt,
		userPrompt,
		fileRefs: fileRefsResult.fileRefs,
		promptTokens: tokenEst(prompt),
	};
}

function createExtractionState(): ExtractionState {
	return { textParts: [], candidates: [], slots: [], error: null, nextID: 1 };
}

function extractResponsesUserInput(
	state: ExtractionState,
	input: unknown,
): void {
	if (state.error || input == null) return;
	if (typeof input === "string") {
		appendText(state, input);
		return;
	}
	if (Array.isArray(input)) {
		for (const item of input) {
			if (state.error) return;
			extractResponseItem(state, item);
		}
		return;
	}
	extractResponseItem(state, input);
}

function extractResponseItem(state: ExtractionState, item: unknown): void {
	if (state.error || item == null) return;
	if (typeof item === "string") {
		appendText(state, item);
		return;
	}
	if (!isRecord(item)) return;
	const role = normalizedType(item.role);
	const typ = normalizedType(item.type);
	if (role && role !== "user") return;
	if (
		typ === "output_text" ||
		typ === "summary_text" ||
		typ === "reasoning" ||
		typ === "thinking" ||
		typ === "function_call" ||
		typ === "function_call_output"
	)
		return;
	if (typ === "input_text" || typ === "text") {
		appendText(state, item.text);
		return;
	}
	if (isImagePartType(typ)) {
		appendImagePart(state, item);
		return;
	}
	if (isFilePartType(typ)) {
		appendFilePart(state, item);
		return;
	}
	if (role === "user" || typ === "message" || typ === "input_message") {
		if (item.content != null) extractContent(state, item.content);
		else appendText(state, item.text);
	}
}

function extractLatestChatUserInput(
	state: ExtractionState,
	messages: unknown,
): void {
	if (!Array.isArray(messages)) return;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!isRecord(msg) || normalizedType(msg.role) !== "user") continue;
		extractContent(state, msg.content != null ? msg.content : msg.text);
		return;
	}
}

function extractContent(state: ExtractionState, content: unknown): void {
	if (state.error || content == null) return;
	if (typeof content === "string") {
		appendText(state, content);
		return;
	}
	if (Array.isArray(content)) {
		for (const part of content) {
			if (state.error) return;
			extractContentPart(state, part);
		}
		return;
	}
	extractContentPart(state, content);
}

function extractContentPart(state: ExtractionState, part: unknown): void {
	if (state.error || part == null) return;
	if (typeof part === "string") {
		appendText(state, part);
		return;
	}
	if (!isRecord(part)) return;
	const typ = normalizedType(part.type);
	if (typ === "text" || typ === "input_text") {
		appendText(state, part.text);
		return;
	}
	if (
		typ === "output_text" ||
		typ === "summary_text" ||
		typ === "reasoning" ||
		typ === "thinking"
	)
		return;
	if (isImagePartType(typ) || part.image_url != null) {
		appendImagePart(state, part);
		return;
	}
	if (isFilePartType(typ)) appendFilePart(state, part);
}

function appendText(state: ExtractionState, value: unknown): void {
	const text =
		typeof value === "string" || typeof value === "number"
			? String(value).trim()
			: "";
	if (text) state.textParts.push(text);
}

function appendImagePart(state: ExtractionState, part: UnknownRecord): void {
	if (remoteUrlFromPart(part)) {
		state.error = unsupportedImageInput(
			"remote image/file URLs are not supported in image generation mode",
		);
		return;
	}
	const existing = existingRefFromPart(part);
	const hasInline = hasImageInlinePayload(part);
	if (existing && !hasInline) {
		state.slots.push({ type: "existing", ref: existing });
		return;
	}

	const image = imageCandidateFromPart(part, state.nextID);
	if ("error" in image) {
		state.error = image.error;
		return;
	}
	addCandidateSlot(state, image.candidate);
}

function appendImageBytes(
	state: ExtractionState,
	image: ImageGenerationByteInput,
): void {
	const detected = detectUploadMimeFromBytes(image.bytes);
	if (!normalizeMimeType(detected).startsWith("image/")) {
		state.error = unsupportedImageInput(
			"image input bytes are not a supported image",
		);
		return;
	}
	const mime = firstNonEmptyString(detected, image.mime, "image/png");
	const candidate: AttachmentCandidate = {
		id: `att_${state.nextID}`,
		kind: "image",
		role: "request",
		source: { type: "bytes", bytes: image.bytes },
	};
	const filename = firstNonEmptyString(
		sanitizeUploadFilename(image.filename),
		imageFilenameFromMime(mime, state.nextID),
	);
	if (filename) candidate.filename = filename;
	if (mime) candidate.mime = mime;
	addCandidateSlot(state, candidate);
}

function appendFilePart(state: ExtractionState, part: UnknownRecord): void {
	if (remoteUrlFromPart(part)) {
		state.error = unsupportedImageInput(
			"remote image/file URLs are not supported in image generation mode",
		);
		return;
	}
	const existing = existingRefFromPart(part);
	const input = normalizeUploadFileInput(part);
	if (existing && !(input && input.b64 != null)) {
		state.slots.push({ type: "existing", ref: existing });
		return;
	}
	if (!input || input.b64 == null) {
		state.error = unsupportedImageInput(
			"image generation file input must be an inline payload or existing file reference",
		);
		return;
	}
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(input.b64);
	} catch (_) {
		state.error = unsupportedImageInput("invalid file base64 payload");
		return;
	}
	const detected = detectUploadMimeFromBytes(bytes);
	if (!normalizeMimeType(detected).startsWith("image/")) {
		state.error = unsupportedImageInput(
			"image generation file input bytes are not a supported image",
		);
		return;
	}
	const mime = firstNonEmptyString(
		detected,
		input.mime,
		uploadMimeFromObject(part),
		"image/png",
	);
	const candidate: AttachmentCandidate = {
		id: `att_${state.nextID}`,
		kind: "image",
		role: "request",
		source: { type: "bytes", bytes },
	};
	const filename = firstNonEmptyString(
		sanitizeUploadFilename(input.filename),
		uploadFilenameFromObject(part),
		imageFilenameFromMime(mime, state.nextID),
	);
	if (filename) candidate.filename = filename;
	if (mime) candidate.mime = mime;
	addCandidateSlot(state, candidate);
}

function imageCandidateFromPart(
	part: UnknownRecord,
	nextID: number,
): { candidate: AttachmentCandidate } | { error: ImageGenerationPrepareError } {
	const parsed = imagePayloadFromPart(part);
	if (!parsed)
		return {
			error: unsupportedImageInput(
				"image input must be an inline image payload or existing file reference",
			),
		};
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(parsed.b64);
	} catch (_) {
		return { error: unsupportedImageInput("invalid image base64 payload") };
	}
	const detected = detectUploadMimeFromBytes(bytes);
	if (!normalizeMimeType(detected).startsWith("image/")) {
		return {
			error: unsupportedImageInput(
				"image input bytes are not a supported image",
			),
		};
	}
	const mime = firstNonEmptyString(
		detected,
		parsed.mime,
		uploadMimeFromObject(part),
		"image/png",
	);
	const candidate: AttachmentCandidate = {
		id: `att_${nextID}`,
		kind: "image",
		role: "request",
		source: { type: "bytes", bytes },
	};
	const filename = firstNonEmptyString(
		imageFilenameFromObject(part),
		imageFilenameFromMime(mime, nextID),
	);
	if (filename) candidate.filename = filename;
	if (mime) candidate.mime = mime;
	return { candidate };
}

function imagePayloadFromPart(
	part: UnknownRecord,
): { b64: unknown; mime: string } | null {
	const source = isRecord(part.source) ? part.source : null;
	if (source && source.data != null) {
		return {
			b64: source.data,
			mime: firstNonEmptyString(
				uploadMimeFromObject(part),
				source.media_type,
				source.mime_type,
				source.mimeType,
				"image/png",
			),
		};
	}
	const imageUrl = part.image_url != null ? part.image_url : part.url;
	const rawUrl = isRecord(imageUrl) ? imageUrl.url : imageUrl;
	const parsed = parseImageUrl(rawUrl, uploadMimeFromObject(part));
	if (parsed) return parsed;
	return null;
}

function hasImageInlinePayload(part: UnknownRecord): boolean {
	const source = isRecord(part.source) ? part.source : null;
	if (source && source.data != null) return true;
	const imageUrl = part.image_url != null ? part.image_url : part.url;
	const rawUrl = isRecord(imageUrl) ? imageUrl.url : imageUrl;
	return typeof rawUrl === "string" && /^data:/i.test(rawUrl.trim());
}

function addCandidateSlot(
	state: ExtractionState,
	candidate: AttachmentCandidate,
): void {
	if (state.candidates.length >= MAX_ATTACHMENTS_PER_REQUEST) {
		state.error = {
			message: `image generation supports at most ${MAX_ATTACHMENTS_PER_REQUEST} user attachments`,
			status: 400,
			code: "image_input_unsupported",
		};
		return;
	}
	const index = state.candidates.length;
	state.candidates.push(candidate);
	state.slots.push({ type: "candidate", index });
	state.nextID += 1;
}

async function resolveImageGenerationFileRefs(
	provider: CompletionProvider,
	state: ExtractionState,
): Promise<
	{ fileRefs: FileRef[] | null } | { error: ImageGenerationPrepareError }
> {
	if (
		!state.candidates.length &&
		!state.slots.some((slot) => slot.type === "existing")
	)
		return { fileRefs: null };
	const plan: AttachmentPlan = {
		candidates: state.candidates,
		existingFileRefs: state.slots
			.filter(
				(slot): slot is { type: "existing"; ref: AttachmentFileRef } =>
					slot.type === "existing",
			)
			.map((slot) => slot.ref),
		dropped: [],
		maxFiles: MAX_ATTACHMENTS_PER_REQUEST,
	};
	let result: AttachmentResolutionResult;
	try {
		result = await provider.resolveAttachments(plan);
	} catch (e) {
		const error: ImageGenerationPrepareError = {
			message: `failed to upload image generation input: ${upstreamErrorMessage(e)}`,
			status: upstreamErrorStatus(e) || 502,
			code: upstreamErrorCode(e) || "image_input_upload_failed",
		};
		const reason = upstreamErrorReason(e);
		if (reason) error.reason = reason;
		return {
			error,
		};
	}
	const uploaded = result.fileRefs || [];
	const out: FileRef[] = [];
	for (const slot of state.slots) {
		if (slot.type === "existing") {
			out.push(slot.ref);
			continue;
		}
		const ref = uploaded[slot.index];
		if (!ref) {
			return {
				error: {
					message: "failed to upload image generation input",
					status: 502,
					code: "image_input_upload_failed",
				},
			};
		}
		out.push(ref);
	}
	return { fileRefs: out.length ? out : null };
}

function existingRefFromPart(part: UnknownRecord): AttachmentFileRef | null {
	const id =
		part.file_id ?? part.fileId ?? part.file_ref ?? part.fileRef ?? part.ref;
	if (id == null) {
		const file = isRecord(part.file) ? part.file : null;
		const nested = file
			? (file.file_id ??
				file.fileId ??
				file.file_ref ??
				file.fileRef ??
				file.ref ??
				file.id)
			: null;
		if (nested == null) return null;
		const name = firstNonEmptyString(
			uploadFilenameFromObject(file),
			uploadFilenameFromObject(part),
		);
		return name ? { id: String(nested), name } : String(nested);
	}
	const name = uploadFilenameFromObject(part);
	return name ? { id: String(id), name } : String(id);
}

function remoteUrlFromPart(part: UnknownRecord): string {
	const direct = firstNonEmptyString(part.url, part.file_url, part.fileUrl);
	if (isRemoteUrl(direct)) return direct;
	const source = isRecord(part.source) ? part.source : null;
	const sourceUrl = source
		? firstNonEmptyString(
				source.url,
				source.file_url,
				source.fileUrl,
				source.file_uri,
				source.fileUri,
			)
		: "";
	if (isRemoteUrl(sourceUrl)) return sourceUrl;
	const imageUrl = isRecord(part.image_url) ? part.image_url : null;
	if (imageUrl && isRemoteUrl(imageUrl.url)) return String(imageUrl.url);
	const file = isRecord(part.file) ? part.file : null;
	const fileUrl = file
		? firstNonEmptyString(file.url, file.file_url, file.fileUrl)
		: "";
	if (isRemoteUrl(fileUrl)) return fileUrl;
	const fileData = firstRecord(part.fileData, part.file_data);
	const nestedUrl = fileData
		? firstNonEmptyString(fileData.url, fileData.file_uri, fileData.fileUri)
		: "";
	return isRemoteUrl(nestedUrl) ? nestedUrl : "";
}

function isRemoteUrl(value: unknown): boolean {
	return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function unsupportedImageInput(message: string): ImageGenerationPrepareError {
	return { message, status: 400, code: "image_input_unsupported" };
}

function normalizedType(value: unknown): string {
	return String(value || "")
		.trim()
		.toLowerCase();
}

function isImagePartType(typ: string): boolean {
	return typ === "image_url" || typ === "image" || typ === "input_image";
}

function isFilePartType(typ: string): boolean {
	return typ === "input_file" || typ === "file";
}
