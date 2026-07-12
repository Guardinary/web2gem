import { firstRecord, isRecord, type UnknownRecord } from "../shared/types";
import { TEXT_ENCODER } from "../shared/encoding";
import { bytesToBase64 } from "./base64";
import {
	cleanUploadMime,
	firstNonEmptyString,
	mimeFromFilename,
	sanitizeUploadFilename,
} from "./mime";

export type ParsedUploadUrl = { b64: string; mime: string };
export type ParsedImageUrl = ParsedUploadUrl;
export type ParsedDataUrl = { b64: string; mime: string };
export type UploadFileInput = {
	b64?: unknown;
	mime?: unknown;
	filename?: unknown;
	name?: unknown;
	invalidReason?: string;
};

export function parseDataUrl(url: unknown): ParsedDataUrl | null {
	if (!url || typeof url !== "string") return null;
	const trimmed = url.trim();
	if (!isDataUrl(trimmed)) return null;
	const comma = trimmed.indexOf(",");
	if (comma < 0) return null;
	const header = trimmed.slice(0, comma);
	const payload = trimmed.slice(comma + 1);
	const meta = header.slice(5);
	const mime = cleanUploadMime((meta.split(";")[0] || "").toLowerCase());
	if (/;base64(?:;|$)/i.test(meta)) return { b64: payload, mime };
	try {
		return {
			b64: bytesToBase64(TEXT_ENCODER.encode(decodeURIComponent(payload))),
			mime,
		};
	} catch (_) {
		return null;
	}
}

export function parseUploadUrl(url: unknown): ParsedUploadUrl | null {
	if (!url || typeof url !== "string") return null;
	const data = parseDataUrl(url);
	if (data) return data;
	return null;
}

export function parseImageUrl(
	url: unknown,
	explicitMime?: unknown,
): ParsedImageUrl | null {
	const parsed = parseUploadUrl(url);
	if (!parsed) return null;
	return {
		...parsed,
		mime: firstNonEmptyString(
			cleanUploadMime(explicitMime),
			parsed.mime,
			"image/png",
		),
	};
}

export function uploadFilenameFromObject(obj: unknown): string {
	if (!isRecord(obj)) return "";
	const record = obj;
	const source = isRecord(record.source) ? record.source : null;
	const imageUrl = isRecord(record.image_url) ? record.image_url : null;
	const inlineData =
		asOptionalRecord(record.inlineData) || asOptionalRecord(record.inline_data);
	const fileData =
		asOptionalRecord(record.fileData) || asOptionalRecord(record.file_data);
	const file = isRecord(record.file) ? record.file : null;
	return firstNonEmptyString(
		...[
			record.filename,
			record.fileName,
			record.file_name,
			record.name,
			record.displayName,
			record.display_name,
			source &&
				(source.filename ||
					source.fileName ||
					source.file_name ||
					source.name ||
					source.displayName ||
					source.display_name),
			imageUrl &&
				(imageUrl.filename ||
					imageUrl.fileName ||
					imageUrl.file_name ||
					imageUrl.name ||
					imageUrl.displayName ||
					imageUrl.display_name),
			inlineData &&
				(inlineData.filename ||
					inlineData.fileName ||
					inlineData.file_name ||
					inlineData.name ||
					inlineData.displayName ||
					inlineData.display_name),
			fileData &&
				(fileData.filename ||
					fileData.fileName ||
					fileData.file_name ||
					fileData.name ||
					fileData.displayName ||
					fileData.display_name),
			file &&
				(file.filename ||
					file.fileName ||
					file.file_name ||
					file.name ||
					file.displayName ||
					file.display_name),
		].map(sanitizeUploadFilename),
	);
}

export function imageFilenameFromObject(obj: unknown): string {
	return uploadFilenameFromObject(obj);
}

export function uploadMimeFromObject(obj: unknown): string {
	if (!isRecord(obj)) return "";
	const record = obj;
	const source = isRecord(record.source) ? record.source : null;
	const imageUrl = isRecord(record.image_url) ? record.image_url : null;
	const inlineData =
		asOptionalRecord(record.inlineData) || asOptionalRecord(record.inline_data);
	const fileData =
		asOptionalRecord(record.fileData) || asOptionalRecord(record.file_data);
	const file = isRecord(record.file) ? record.file : null;
	return firstNonEmptyString(
		record.mime,
		record.mime_type,
		record.mimeType,
		record.media_type,
		record.mediaType,
		record.content_type,
		record.contentType,
		source &&
			(source.mime ||
				source.mime_type ||
				source.mimeType ||
				source.media_type ||
				source.mediaType ||
				source.content_type ||
				source.contentType),
		imageUrl &&
			(imageUrl.mime ||
				imageUrl.mime_type ||
				imageUrl.mimeType ||
				imageUrl.content_type ||
				imageUrl.contentType),
		inlineData &&
			(inlineData.mime ||
				inlineData.mime_type ||
				inlineData.mimeType ||
				inlineData.media_type ||
				inlineData.mediaType ||
				inlineData.content_type ||
				inlineData.contentType),
		fileData &&
			(fileData.mime ||
				fileData.mime_type ||
				fileData.mimeType ||
				fileData.media_type ||
				fileData.mediaType ||
				fileData.content_type ||
				fileData.contentType),
		file &&
			(file.mime ||
				file.mime_type ||
				file.mimeType ||
				file.media_type ||
				file.mediaType ||
				file.content_type ||
				file.contentType),
	);
}

export function normalizeUploadFileInput(
	file: unknown,
): UploadFileInput | null {
	if (typeof file === "string") {
		const parsed = parseUploadUrl(file);
		if (!parsed) return null;
		return { b64: parsed.b64, mime: parsed.mime || "application/octet-stream" };
	}
	if (!isRecord(file)) return null;
	const source = isRecord(file.source) ? file.source : null;
	const nestedFile = isRecord(file.file) ? file.file : null;
	const fileData = firstRecord(file.fileData, file.file_data);
	const filename = uploadFilenameFromObject(file);
	const explicitMime = uploadMimeFromObject(file);
	const urlValue = firstNonEmptyString(
		file.url,
		file.file_url,
		file.fileUrl,
		source?.url,
		nestedFile && (nestedFile.url || nestedFile.file_url || nestedFile.fileUrl),
		fileData?.url,
	);
	const dataValue = firstNonNil(
		fileData &&
			(fileData.data ??
				fileData.b64 ??
				fileData.base64 ??
				fileData.fileData ??
				fileData.file_data),
		file.file_data,
		file.fileData,
		file.data,
		file.b64,
		file.base64,
		source && (source.data ?? source.b64 ?? source.base64),
		nestedFile && (nestedFile.data ?? nestedFile.b64 ?? nestedFile.base64),
	);
	const parsedUrl = parseUploadUrl(urlValue);
	if (parsedUrl)
		return uploadInputFromParsed(parsedUrl, explicitMime, filename);
	const parsedData = parseUploadUrl(dataValue);
	if (parsedData)
		return uploadInputFromParsed(parsedData, explicitMime, filename);
	if (dataValue != null && typeof dataValue !== "object") {
		const out: UploadFileInput = { b64: dataValue };
		const mime = firstNonEmptyString(explicitMime, mimeFromFilename(filename));
		if (mime) out.mime = mime;
		if (filename) out.filename = filename;
		return out;
	}
	if (
		isExplicitUploadFileInput(file) &&
		!hasExistingUploadFileReference(file) &&
		!(fileData && (fileData.fileUri || fileData.file_uri))
	) {
		const out: UploadFileInput = {
			invalidReason: "missing generic file upload data",
		};
		const mime = firstNonEmptyString(explicitMime, mimeFromFilename(filename));
		if (mime) out.mime = mime;
		if (filename) out.filename = filename;
		return out;
	}
	return null;
}

export function hasInlineUploadFilePayload(raw: unknown): boolean {
	return !!normalizeUploadFileInput(raw);
}

export function isDataUrl(raw: string): boolean {
	return /^data:/i.test(raw.trim());
}

function uploadInputFromParsed(
	parsed: ParsedUploadUrl,
	explicitMime: string,
	filename: string,
): UploadFileInput {
	const out: UploadFileInput = {
		b64: parsed.b64,
		mime:
			firstNonEmptyString(
				explicitMime,
				parsed.mime,
				mimeFromFilename(filename),
			) || "application/octet-stream",
	};
	if (filename) out.filename = filename;
	return out;
}

function firstNonNil(...values: unknown[]): unknown {
	for (const value of values) {
		if (value !== undefined && value !== null) return value;
	}
	return undefined;
}

function isExplicitUploadFileInput(file: UnknownRecord): boolean {
	const typ = String(file.type || "")
		.trim()
		.toLowerCase();
	return typ === "input_file" || typ === "file";
}

function hasExistingUploadFileReference(file: UnknownRecord): boolean {
	if (file.file_id != null || file.id != null) return true;
	const nestedFile = isRecord(file.file) ? file.file : null;
	return !!(
		nestedFile &&
		(nestedFile.file_id != null || nestedFile.id != null)
	);
}

function asOptionalRecord(value: unknown): UnknownRecord | null {
	return isRecord(value) ? value : null;
}
