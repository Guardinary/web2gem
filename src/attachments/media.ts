import { isRecord, type UnknownRecord } from "../shared/types";
import { TEXT_DECODER, TEXT_ENCODER, UTF8_FATAL_DECODER } from "../shared/runtime";

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

const MIME_MAX_LENGTH = 180;

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
    return { b64: bytesToBase64(TEXT_ENCODER.encode(decodeURIComponent(payload))), mime };
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

export function parseImageUrl(url: unknown, explicitMime?: unknown): ParsedImageUrl | null {
  const parsed = parseUploadUrl(url);
  if (!parsed) return null;
  return { ...parsed, mime: firstNonEmptyString(cleanUploadMime(explicitMime), parsed.mime, "image/png") };
}

export function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function sanitizeUploadFilename(name: unknown): string {
  if (typeof name !== "string" && typeof name !== "number") return "";
  let safeName = String(name || "").trim();
  if (!safeName) return "";
  safeName = safeName.replace(/\0/g, "").replace(/[\r\n\t]/g, " ").trim();
  safeName = safeName.split(/[\\/]/).filter(Boolean).pop() || "";
  safeName = safeName.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!safeName || safeName === "." || safeName === "..") return "";
  return safeName.slice(0, 180);
}

export function filenameFromUrl(url: unknown): string {
  if (!url || typeof url !== "string") return "";
  try {
    const u = new URL(url);
    const last = decodeURIComponent((u.pathname || "").split("/").filter(Boolean).pop() || "");
    return sanitizeUploadFilename(last);
  } catch (_) {
    const path = String(url || "").split(/[?#]/)[0];
    return sanitizeUploadFilename(path);
  }
}

export function uploadFilenameFromObject(obj: unknown): string {
  if (!isRecord(obj)) return "";
  const record = obj;
  const source = isRecord(record.source) ? record.source : null;
  const imageUrl = isRecord(record.image_url) ? record.image_url : null;
  const inlineData = asOptionalRecord(record.inlineData) || asOptionalRecord(record.inline_data);
  const fileData = asOptionalRecord(record.fileData) || asOptionalRecord(record.file_data);
  const file = isRecord(record.file) ? record.file : null;
  return firstNonEmptyString(...[
    record.filename, record.fileName, record.file_name, record.name, record.displayName, record.display_name,
    source && (source.filename || source.fileName || source.file_name || source.name || source.displayName || source.display_name),
    imageUrl && (imageUrl.filename || imageUrl.fileName || imageUrl.file_name || imageUrl.name || imageUrl.displayName || imageUrl.display_name),
    inlineData && (inlineData.filename || inlineData.fileName || inlineData.file_name || inlineData.name || inlineData.displayName || inlineData.display_name),
    fileData && (fileData.filename || fileData.fileName || fileData.file_name || fileData.name || fileData.displayName || fileData.display_name),
    file && (file.filename || file.fileName || file.file_name || file.name || file.displayName || file.display_name),
  ].map(sanitizeUploadFilename));
}

export function imageFilenameFromObject(obj: unknown): string {
  return uploadFilenameFromObject(obj);
}

export function uploadMimeFromObject(obj: unknown): string {
  if (!isRecord(obj)) return "";
  const record = obj;
  const source = isRecord(record.source) ? record.source : null;
  const imageUrl = isRecord(record.image_url) ? record.image_url : null;
  const inlineData = asOptionalRecord(record.inlineData) || asOptionalRecord(record.inline_data);
  const fileData = asOptionalRecord(record.fileData) || asOptionalRecord(record.file_data);
  const file = isRecord(record.file) ? record.file : null;
  return firstNonEmptyString(
    record.mime,
    record.mime_type,
    record.mimeType,
    record.media_type,
    record.mediaType,
    record.content_type,
    record.contentType,
    source && (source.mime || source.mime_type || source.mimeType || source.media_type || source.mediaType || source.content_type || source.contentType),
    imageUrl && (imageUrl.mime || imageUrl.mime_type || imageUrl.mimeType || imageUrl.content_type || imageUrl.contentType),
    inlineData && (inlineData.mime || inlineData.mime_type || inlineData.mimeType || inlineData.media_type || inlineData.mediaType || inlineData.content_type || inlineData.contentType),
    fileData && (fileData.mime || fileData.mime_type || fileData.mimeType || fileData.media_type || fileData.mediaType || fileData.content_type || fileData.contentType),
    file && (file.mime || file.mime_type || file.mimeType || file.media_type || file.mediaType || file.content_type || file.contentType),
  );
}

export function normalizeUploadFileInput(file: unknown): UploadFileInput | null {
  if (typeof file === "string") {
    const parsed = parseUploadUrl(file);
    if (!parsed) return null;
    return { b64: parsed.b64, mime: parsed.mime || "application/octet-stream" };
  }
  if (!isRecord(file)) return null;
  const source = isRecord(file.source) ? file.source : null;
  const nestedFile = isRecord(file.file) ? file.file : null;
  const fileData = isRecord(file.fileData) ? file.fileData : (isRecord(file.file_data) ? file.file_data : null);
  const filename = uploadFilenameFromObject(file);
  const explicitMime = uploadMimeFromObject(file);
  const urlValue = firstNonEmptyString(
    file.url,
    file.file_url,
    file.fileUrl,
    source && source.url,
    nestedFile && (nestedFile.url || nestedFile.file_url || nestedFile.fileUrl),
    fileData && fileData.url,
  );
  const dataValue = firstNonNil(
    fileData && (fileData.data ?? fileData.b64 ?? fileData.base64 ?? fileData.fileData ?? fileData.file_data),
    file.file_data,
    file.fileData,
    file.data,
    file.b64,
    file.base64,
    source && (source.data ?? source.b64 ?? source.base64),
    nestedFile && (nestedFile.data ?? nestedFile.b64 ?? nestedFile.base64),
  );
  const parsedUrl = parseUploadUrl(urlValue);
  if (parsedUrl) return uploadInputFromParsed(parsedUrl, explicitMime, filename);
  const parsedData = parseUploadUrl(dataValue);
  if (parsedData) return uploadInputFromParsed(parsedData, explicitMime, filename);
  if (dataValue != null && typeof dataValue !== "object") {
    const out: UploadFileInput = { b64: dataValue };
    const mime = firstNonEmptyString(explicitMime, mimeFromFilename(filename));
    if (mime) out.mime = mime;
    if (filename) out.filename = filename;
    return out;
  }
  if (isExplicitUploadFileInput(file) && !hasExistingUploadFileReference(file) && !(fileData && (fileData.fileUri || fileData.file_uri))) {
    const out: UploadFileInput = { invalidReason: "missing generic file upload data" };
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

export function mimeFromFilename(name: unknown): string {
  const safeName = sanitizeUploadFilename(name).toLowerCase();
  const ext = safeName.includes(".") ? safeName.split(".").pop() || "" : "";
  switch (ext) {
    case "txt":
    case "log":
      return "text/plain";
    case "md":
    case "markdown":
      return "text/markdown";
    case "csv":
      return "text/csv";
    case "json":
      return "application/json";
    case "jsonl":
      return "application/x-ndjson";
    case "js":
    case "mjs":
    case "cjs":
      return "text/javascript";
    case "ts":
    case "tsx":
      return "text/typescript";
    case "py":
      return "text/x-python";
    case "html":
    case "htm":
      return "text/html";
    case "css":
      return "text/css";
    case "xml":
      return "application/xml";
    case "pdf":
      return "application/pdf";
    default:
      return "";
  }
}

export function genericFilenameFromMime(mime: unknown, index: number): string {
  const base = `file-${Math.max(1, Math.floor(index) || 1)}`;
  const typ = normalizeMimeType(mime);
  switch (typ) {
    case "text/markdown":
      return `${base}.md`;
    case "text/csv":
      return `${base}.csv`;
    case "application/json":
      return `${base}.json`;
    case "application/x-ndjson":
      return `${base}.jsonl`;
    case "text/javascript":
    case "application/javascript":
      return `${base}.js`;
    case "text/typescript":
      return `${base}.ts`;
    case "text/x-python":
      return `${base}.py`;
    case "text/html":
      return `${base}.html`;
    case "text/css":
      return `${base}.css`;
    case "application/xml":
    case "text/xml":
      return `${base}.xml`;
    case "application/pdf":
      return `${base}.pdf`;
    case "text/plain":
      return `${base}.txt`;
    default:
      if (typ.startsWith("text/")) return `${base}.txt`;
      return `${base}.bin`;
  }
}

export function imageFilenameFromMime(mime: unknown, index: number): string {
  const base = `image${index > 1 ? `-${index}` : ""}`;
  const typ = normalizeMimeType(mime);
  switch (typ) {
    case "image/jpeg":
    case "image/jpg":
      return `${base}.jpg`;
    case "image/webp":
      return `${base}.webp`;
    case "image/gif":
      return `${base}.gif`;
    case "image/bmp":
      return `${base}.bmp`;
    case "image/heic":
      return `${base}.heic`;
    case "image/heif":
      return `${base}.heif`;
    case "image/png":
    default:
      return `${base}.png`;
  }
}

export function cleanUploadMime(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value || "").replace(/[\r\n]/g, "").trim().slice(0, MIME_MAX_LENGTH);
}

export function chooseUploadMime(...values: unknown[]): string {
  for (const value of values) {
    const mime = cleanUploadMime(value);
    if (mime) return mime;
  }
  return "application/octet-stream";
}

export function detectUploadMimeFromBytes(bytes: Uint8Array): string {
  if (!bytes || bytes.byteLength === 0) return "";
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")) return "image/gif";
  if (startsWithAscii(bytes, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
  if (startsWithAscii(bytes, "%PDF-")) return "application/pdf";
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (looksLikeUtf8Text(bytes)) {
    const text = TEXT_DECODER.decode(bytes.slice(0, Math.min(bytes.byteLength, 4096))).trimStart();
    if (text.startsWith("{") || text.startsWith("[")) return "application/json";
    return "text/plain";
  }
  return "";
}

export function normalizeMimeType(value: unknown): string {
  return (String(value || "").split(";")[0] || "").trim().toLowerCase();
}

export function isDataUrl(raw: string): boolean {
  return /^data:/i.test(raw.trim());
}

export function base64DecodedByteLength(raw: string): number {
  const compact = String(raw || "").replace(/\s+/g, "");
  if (!compact) return 0;
  const unpaddedLength = compact.replace(/=+$/, "").length;
  return Math.floor((unpaddedLength * 3) / 4);
}

export function validateBase64Shape(raw: unknown): string {
  const compact = String(raw || "").replace(/\s+/g, "");
  if (compact && (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) || compact.length % 4 === 1 || /=(?=.*[^=])/.test(compact))) {
    throw new Error("invalid base64 payload");
  }
  return compact;
}

export function base64ToBytes(b64: unknown): Uint8Array {
  const compact = validateBase64Shape(b64);
  const hasBase64UrlAlphabet = /[-_]/.test(compact);
  if (typeof (Uint8Array as any).fromBase64 === "function") {
    return (Uint8Array as any).fromBase64(
      compact,
      hasBase64UrlAlphabet ? { alphabet: "base64url" } : undefined,
    );
  }
  let standardB64 = compact;
  if (hasBase64UrlAlphabet) {
    standardB64 = compact.replace(/-/g, "+").replace(/_/g, "/");
  }
  return Uint8Array.from(Buffer.from(standardB64, "base64"));
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof (bytes as any).toBase64 === "function") {
    return (bytes as any).toBase64();
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

type Uint8ArrayBase64Alphabet = "base64" | "base64url";

type Uint8ArrayBase64Constructor = typeof Uint8Array & {
  fromBase64(value: string, options?: { alphabet?: Uint8ArrayBase64Alphabet }): Uint8Array;
};

type Uint8ArrayBase64 = Uint8Array & {
  toBase64(options?: { alphabet?: Uint8ArrayBase64Alphabet; omitPadding?: boolean }): string;
};

function uploadInputFromParsed(parsed: ParsedUploadUrl, explicitMime: string, filename: string): UploadFileInput {
  const out: UploadFileInput = {
    b64: parsed.b64,
    mime: firstNonEmptyString(explicitMime, parsed.mime, mimeFromFilename(filename)) || "application/octet-stream",
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
  const typ = String(file.type || "").trim().toLowerCase();
  return typ === "input_file" || typ === "file";
}

function hasExistingUploadFileReference(file: UnknownRecord): boolean {
  if (file.file_id != null || file.id != null) return true;
  const nestedFile = isRecord(file.file) ? file.file : null;
  return !!(nestedFile && (nestedFile.file_id != null || nestedFile.id != null));
}

function asOptionalRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  return asciiAt(bytes, 0, prefix);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.byteLength < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, Math.min(bytes.byteLength, 4096));
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controls += 1;
  }
  if (controls > 0) return false;
  try {
    UTF8_FATAL_DECODER.decode(sample);
    return true;
  } catch (_) {
    return false;
  }
}
