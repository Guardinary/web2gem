import type {
	ImageGenerationByteInput,
	ImageGenerationUserImageInput,
} from "../../completion/image-generation";
import { MAX_ATTACHMENTS_PER_REQUEST } from "../../attachments/plan";
import type { RuntimeConfig } from "../../config";
import { isRecord, type UnknownRecord } from "../../shared/types";
import { readRequestBodyBytes } from "../core/json";
import { openAIErrorResponse } from "./errors";

const MULTIPART_IMAGE_FIELD_NAMES = new Set([
	"image",
	"image[]",
	"images",
	"images[]",
	"image_url",
	"image_url[]",
	"input_image",
	"input_image[]",
]);
const MULTIPART_FORM_OVERHEAD_BYTES = 1024 * 1024;

type ParsedImageEditMultipartRequest = {
	body: UnknownRecord;
	imageInputs: ImageGenerationUserImageInput[];
};

export function collectImageEditParts(req: UnknownRecord): UnknownRecord[] {
	const parts: UnknownRecord[] = [];
	appendImageInputValue(parts, req.image);
	appendImageInputValue(parts, req.images);
	appendImageInputValue(parts, req.image_url);
	appendImageInputValue(parts, req.input_image);
	return parts;
}

export async function parseImageEditMultipartRequest(
	request: Request,
	cfg: RuntimeConfig,
): Promise<ParsedImageEditMultipartRequest | { response: Response }> {
	const maxBodyBytes = multipartImageEditBodyLimit(cfg);
	const read = await readRequestBodyBytes(request, {
		maxBodyBytes,
		oversizedError: {
			message: `multipart image edit request body is too large (${maxBodyBytes} byte limit)`,
			status: 413,
			code: "image_input_too_large",
		},
	});
	if (read.error !== undefined)
		return {
			response: openAIErrorResponse(read.error, read.status, read.code),
		};

	let form: FormData;
	try {
		form = await new Request(request.url, {
			method: "POST",
			headers: request.headers,
			body: new Uint8Array(read.value).buffer,
		}).formData();
	} catch (_) {
		return {
			response: openAIErrorResponse(
				"invalid multipart form data",
				400,
				"invalid_multipart_form",
			),
		};
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

export function parseImageEndpointBoolean(
	value: unknown,
): { value: boolean | undefined } | { response: Response } {
	if (value == null) return { value: undefined };
	if (typeof value === "boolean") return { value };
	if (typeof value === "number") {
		if (value === 1) return { value: true };
		if (value === 0) return { value: false };
		return invalidBooleanResponse();
	}
	if (typeof value !== "string") return invalidBooleanResponse();

	const normalized = value.trim().toLowerCase();
	if (!normalized) return { value: undefined };
	if (["true", "1", "yes", "on"].includes(normalized)) return { value: true };
	if (["false", "0", "no", "off"].includes(normalized)) return { value: false };
	return invalidBooleanResponse();
}

function invalidBooleanResponse(): { response: Response } {
	return {
		response: openAIErrorResponse(
			"stream must be a boolean",
			400,
			"invalid_request",
		),
	};
}

function multipartImageEditBodyLimit(cfg: RuntimeConfig): number {
	const configured = Math.max(
		0,
		Math.floor(Number(cfg.generic_file_upload_max_bytes) || 0),
	);
	return configured + MULTIPART_FORM_OVERHEAD_BYTES;
}

function imageEditBodyFromForm(
	form: FormData,
): { body: UnknownRecord } | { response: Response } {
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

function appendMultipartImageText(
	inputs: ImageGenerationUserImageInput[],
	value: string,
): void {
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

async function appendMultipartImageFile(
	inputs: ImageGenerationUserImageInput[],
	file: File,
	cfg: RuntimeConfig,
): Promise<{ ok: true } | { response: Response }> {
	if (inputs.length >= MAX_ATTACHMENTS_PER_REQUEST) {
		return {
			response: openAIErrorResponse(
				`image generation supports at most ${MAX_ATTACHMENTS_PER_REQUEST} user attachments`,
				400,
				"image_input_unsupported",
			),
		};
	}

	const maxBytes = Math.max(
		0,
		Math.floor(Number(cfg.generic_file_upload_max_bytes) || 0),
	);
	if (Number.isFinite(file.size) && file.size > maxBytes) {
		return {
			response: openAIErrorResponse(
				`image input is too large (${file.size} bytes > ${maxBytes})`,
				413,
				"image_input_too_large",
			),
		};
	}

	let bytes: Uint8Array;
	try {
		bytes = await file.bytes();
	} catch (_) {
		return {
			response: openAIErrorResponse(
				"failed to read multipart image file",
				400,
				"image_input_unsupported",
			),
		};
	}
	if (bytes.byteLength > maxBytes) {
		return {
			response: openAIErrorResponse(
				`image input is too large (${bytes.byteLength} bytes > ${maxBytes})`,
				413,
				"image_input_too_large",
			),
		};
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
	if (
		typeof urlValue === "string" &&
		urlValue.trim() &&
		!isUrlLikeImageInput(urlValue)
	) {
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
	if (isUrlLikeImageInput(trimmed))
		return { type: "input_image", image_url: trimmed };
	return {
		type: "input_image",
		source: { data: trimmed, media_type: "image/png" },
	};
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
