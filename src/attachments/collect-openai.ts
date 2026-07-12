import { isRecord } from "../shared/types";
import {
	imageFilenameFromObject,
	normalizeUploadFileInput,
	parseImageUrl,
	uploadMimeFromObject,
	type UploadFileInput,
} from "./input";
import { createAttachmentPlan } from "./plan";
import { collectOpenAIRefFileIDs } from "./refs";
import type { AttachmentPlan } from "./types";

const FULL_INLINE_UPLOAD_KEYS = [
	"messages",
	"input",
	"attachments",
	"content",
	"files",
	"items",
	"data",
	"source",
	"file",
	"image_url",
];
const CONTAINER_INLINE_UPLOAD_KEYS = [
	"attachments",
	"files",
	"items",
	"data",
	"source",
	"file",
	"image_url",
];
const FILE_BLOCK_CONTAINER_KEYS = ["attachments", "files", "items"];

export function collectOpenAIRequestAttachmentPlan(
	req: unknown,
): AttachmentPlan {
	const inline = collectOpenAIInlineUploads(req);
	return createAttachmentPlan({
		existingFileRefs: collectOpenAIRefFileIDs(req),
		images: inline.images,
		files: inline.files,
	});
}

export function collectOpenAIInlineUploadFiles(
	req: unknown,
): UploadFileInput[] | null {
	return collectOpenAIInlineUploads(req).files;
}

export function collectOpenAIInlineUploadImages(
	req: unknown,
): Array<{ b64: string; mime: string; filename?: string }> | null {
	return collectOpenAIInlineUploads(req).images;
}

function collectOpenAIInlineUploads(req: unknown): {
	files: UploadFileInput[] | null;
	images: Array<{ b64: string; mime: string; filename?: string }> | null;
} {
	if (!isRecord(req)) return { files: null, images: null };
	const state: InlineUploadState = { files: [], images: [] };
	for (const key of ["attachments", "files"])
		appendOpenAIInlineUploadInputs(state, req[key], "full");
	for (const key of ["messages", "input"])
		appendOpenAIInlineUploadInputs(state, req[key], "container");
	return {
		files: state.files.length ? state.files : null,
		images: state.images.length ? state.images : null,
	};
}

type InlineUploadWalkMode = "full" | "container";
type InlineUploadState = {
	files: UploadFileInput[];
	images: Array<{ b64: string; mime: string; filename?: string }>;
};

function appendOpenAIInlineUploadInputs(
	state: InlineUploadState,
	raw: unknown,
	mode: InlineUploadWalkMode,
): void {
	if (raw == null) return;
	if (Array.isArray(raw)) {
		for (const item of raw) appendOpenAIInlineUploadInputs(state, item, mode);
		return;
	}
	if (!isRecord(raw)) return;
	if (mode === "full") {
		const image = normalizeImageUploadInput(raw);
		if (image) {
			state.images.push(image);
			return;
		}
		const input = normalizeUploadFileInput(raw);
		if (input) {
			state.files.push(input);
			return;
		}
	}
	const keys = inlineUploadNestedKeys(raw, mode);
	for (const key of keys) {
		if (!(key in raw)) continue;
		const nextMode: InlineUploadWalkMode =
			key === "attachments" || key === "files" || key === "file"
				? "full"
				: mode;
		appendOpenAIInlineUploadInputs(state, raw[key], nextMode);
	}
}

function inlineUploadNestedKeys(
	raw: Record<string, unknown>,
	mode: InlineUploadWalkMode,
): readonly string[] {
	if (mode === "full") return FULL_INLINE_UPLOAD_KEYS;
	if (isOpenAIFileBlock(raw)) return FILE_BLOCK_CONTAINER_KEYS;
	return CONTAINER_INLINE_UPLOAD_KEYS;
}

function isOpenAIFileBlock(raw: Record<string, unknown>): boolean {
	const typ = String(raw.type || "")
		.trim()
		.toLowerCase();
	return typ === "input_file" || typ === "file";
}

function normalizeImageUploadInput(
	raw: Record<string, unknown>,
): { b64: string; mime: string; filename?: string } | null {
	const typ = String(raw.type || "")
		.trim()
		.toLowerCase();
	if (
		typ !== "image_url" &&
		typ !== "image" &&
		typ !== "input_image" &&
		!("image_url" in raw)
	)
		return null;
	const source = isRecord(raw.source) ? raw.source : null;
	if (source && source.data != null) {
		const out = {
			b64: String(source.data || ""),
			mime: uploadMimeFromObject(raw) || "image/png",
		};
		const filename = imageFilenameFromObject(raw);
		return filename ? { ...out, filename } : out;
	}
	const imageUrl = raw.image_url != null ? raw.image_url : raw.url;
	const parsed = parseImageUrl(
		isRecord(imageUrl) ? imageUrl.url : imageUrl,
		uploadMimeFromObject(raw),
	);
	if (!parsed) return null;
	const filename = imageFilenameFromObject(raw);
	return filename ? { ...parsed, filename } : parsed;
}
