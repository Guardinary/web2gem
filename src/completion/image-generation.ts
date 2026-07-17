import { base64ToBytes } from "../attachments/base64";
import {
	detectUploadMimeFromBytes,
	imageFilenameFromMime,
	normalizeMimeType,
	sanitizeUploadFilename,
} from "../attachments/mime";
import { firstNonEmptyString } from "../shared/strings";
import { MAX_ATTACHMENTS_PER_REQUEST } from "../attachments/plan";
import type {
	AttachmentCandidate,
	AttachmentFileRef,
	AttachmentPlan,
} from "../attachments/types";
import type { RuntimeConfig } from "../config";
import type { ResolvedModel } from "../models";
import {
	type FilePart,
	type ImagePart,
	type InternalMessage,
	type MessagePart,
	parseMessagePart,
} from "../promptcompat/message-model";
import {
	geminiAuthenticatedSessionRequiredError,
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
	upstreamErrorStatus,
} from "../shared/errors";
import { log } from "../shared/logging";
import { tokenEst } from "../promptcompat/token-accounting";
import { promptByteLength } from "../shared/text-metrics";
import type { UnknownRecord } from "../shared/types";
import { contextFileThreshold } from "./context-files";
import { type CompletionProvider, resolveCompletionModel } from "./ports";
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
	messages: readonly InternalMessage[],
): Promise<
	PreparedImageGenerationCompletion | { error: ImageGenerationPrepareError }
> {
	const state = createExtractionState();
	if (route === "responses") appendResponseMessages(state, messages);
	else appendLatestChatUserMessage(state, messages);
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
			if (imageInput.type === "part")
				appendUserImagePart(state, imageInput.part);
			else appendImageBytes(state, imageInput.image);
		}
	} else if (input.imageParts) {
		for (const part of input.imageParts) {
			if (state.error) break;
			appendUserImagePart(state, part);
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

	const rm = await resolveCompletionModel(provider, model, cfg.default_model);
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

function appendResponseMessages(
	state: ExtractionState,
	messages: readonly InternalMessage[],
): void {
	for (const message of messages) {
		if (state.error) return;
		if (message.role === "user") appendMessageParts(state, message);
	}
}

function appendLatestChatUserMessage(
	state: ExtractionState,
	messages: readonly InternalMessage[],
): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "user") {
			appendMessageParts(state, message);
			return;
		}
	}
}

function appendMessageParts(
	state: ExtractionState,
	message: InternalMessage,
): void {
	for (const part of message.parts) {
		if (state.error) return;
		appendModelPart(state, part);
	}
}

function appendModelPart(
	state: ExtractionState,
	part: MessagePart | null,
): void {
	if (state.error || !part) return;
	if (part.kind === "text") {
		if (part.inputText) appendText(state, part.text);
		return;
	}
	if (part.kind === "reasoning") return;
	if (part.kind === "image") {
		appendImagePart(state, part);
		return;
	}
	appendFilePart(state, part);
}

/** `/v1/images/*` part inputs: already image-shaped records from images-input. */
function appendUserImagePart(state: ExtractionState, raw: UnknownRecord): void {
	const part = parseMessagePart(raw);
	if (part && (part.kind === "image" || part.kind === "file")) {
		appendModelPart(state, part);
		return;
	}
	state.error = unsupportedImageInput(
		"image input must be an inline image payload or existing file reference",
	);
}

function appendText(state: ExtractionState, value: unknown): void {
	const text =
		typeof value === "string" || typeof value === "number"
			? String(value).trim()
			: "";
	if (text) state.textParts.push(text);
}

function appendImagePart(state: ExtractionState, part: ImagePart): void {
	if (part.remoteUrl) {
		state.error = unsupportedImageInput(
			"remote image/file URLs are not supported in image generation mode",
		);
		return;
	}
	if (part.fileRef && !part.hasInline) {
		state.slots.push({ type: "existing", ref: part.fileRef });
		return;
	}
	if (!part.hasInline) {
		state.error = unsupportedImageInput(
			"image input must be an inline image payload or existing file reference",
		);
		return;
	}
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(part.b64);
	} catch (_) {
		state.error = unsupportedImageInput("invalid image base64 payload");
		return;
	}
	const detected = detectUploadMimeFromBytes(bytes);
	if (!normalizeMimeType(detected).startsWith("image/")) {
		state.error = unsupportedImageInput(
			"image input bytes are not a supported image",
		);
		return;
	}
	const mime = firstNonEmptyString(detected, part.mime, "image/png");
	const candidate: AttachmentCandidate = {
		id: `att_${state.nextID}`,
		kind: "image",
		role: "request",
		source: { type: "bytes", bytes },
	};
	const filename = firstNonEmptyString(
		part.filename,
		imageFilenameFromMime(mime, state.nextID),
	);
	if (filename) candidate.filename = filename;
	if (mime) candidate.mime = mime;
	addCandidateSlot(state, candidate);
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

function appendFilePart(state: ExtractionState, part: FilePart): void {
	if (part.remoteUrl) {
		state.error = unsupportedImageInput(
			"remote image/file URLs are not supported in image generation mode",
		);
		return;
	}
	const upload = part.upload;
	const hasInline = !!upload && upload.b64 != null;
	if (part.fileRef && !hasInline) {
		state.slots.push({ type: "existing", ref: part.fileRef });
		return;
	}
	if (!upload || upload.b64 == null) {
		state.error = unsupportedImageInput(
			"image generation file input must be an inline payload or existing file reference",
		);
		return;
	}
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(upload.b64);
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
	const mime = firstNonEmptyString(detected, upload.mime, "image/png");
	const candidate: AttachmentCandidate = {
		id: `att_${state.nextID}`,
		kind: "image",
		role: "request",
		source: { type: "bytes", bytes },
	};
	const filename = firstNonEmptyString(
		upload.filename,
		part.filename,
		imageFilenameFromMime(mime, state.nextID),
	);
	if (filename) candidate.filename = filename;
	if (mime) candidate.mime = mime;
	addCandidateSlot(state, candidate);
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

function unsupportedImageInput(message: string): ImageGenerationPrepareError {
	return { message, status: 400, code: "image_input_unsupported" };
}
