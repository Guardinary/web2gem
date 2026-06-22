import { isRecord, type UnknownRecord } from "./types";

export type ParsedUploadUrl = { url: string } | { b64: string; mime: string };
export type ParsedImageUrl = ParsedUploadUrl;
export type ParsedDataUrl = { b64: string; mime: string };
export type UploadFileInput = {
  url?: string;
  b64?: unknown;
  mime?: unknown;
  filename?: unknown;
  name?: unknown;
  invalidReason?: string;
};

export function parseDataUrl(url: unknown): ParsedDataUrl | null {
  if (!url || typeof url !== "string") return null;
  const m = /^data:([^,]*?);base64,([\s\S]*)$/i.exec(url);
  if (!m) return null;
  return { b64: m[2] || "", mime: ((m[1] || "").split(";")[0] || "").toLowerCase() };
}

export function parseUploadUrl(url: unknown): ParsedUploadUrl | null {
  if (!url || typeof url !== "string") return null;
  const data = parseDataUrl(url);
  if (data) return data;
  if (/^https?:\/\//i.test(url)) return { url };
  return null;
}

export function parseImageUrl(url: unknown): ParsedImageUrl | null {
  const parsed = parseUploadUrl(url);
  if (!parsed) return null;
  if ("b64" in parsed && !parsed.mime) return { ...parsed, mime: "image/png" };
  return parsed;
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
    file && (file.filename || file.fileName || file.file_name || file.name || file.displayName || file.display_name)
  ].map(sanitizeUploadFilename));
}

export function imageFilenameFromObject(obj: unknown): string {
  return uploadFilenameFromObject(obj);
}

function asOptionalRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

export function normalizeUploadFileInput(file: unknown): UploadFileInput | null {
  if (typeof file === "string") {
    const parsed = parseUploadUrl(file);
    if (!parsed) return null;
    if ("url" in parsed) return { url: parsed.url };
    return { b64: parsed.b64, mime: parsed.mime || "application/octet-stream" };
  }
  if (!isRecord(file)) return null;
  const source = isRecord(file.source) ? file.source : null;
  const nestedFile = isRecord(file.file) ? file.file : null;
  const fileData = isRecord(file.fileData) ? file.fileData : (isRecord(file.file_data) ? file.file_data : null);
  const filename = uploadFilenameFromObject(file);
  const explicitMime = firstNonEmptyString(
    file.mime,
    file.mime_type,
    file.media_type,
    file.content_type,
    file.contentType,
    source && (source.mime || source.mime_type || source.media_type || source.content_type || source.contentType),
    nestedFile && (nestedFile.mime || nestedFile.mime_type || nestedFile.media_type || nestedFile.content_type || nestedFile.contentType),
    fileData && (fileData.mimeType || fileData.mime_type || fileData.mime || fileData.media_type || fileData.content_type || fileData.contentType),
  );
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

function uploadInputFromParsed(parsed: ParsedUploadUrl, explicitMime: string, filename: string): UploadFileInput {
  const out: UploadFileInput = "url" in parsed
    ? { url: parsed.url }
    : { b64: parsed.b64, mime: firstNonEmptyString(explicitMime, parsed.mime, mimeFromFilename(filename)) || "application/octet-stream" };
  if (explicitMime && !("mime" in out)) out.mime = explicitMime;
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
  const typ = (String(mime || "").split(";")[0] || "").trim().toLowerCase();
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
  const typ = (String(mime || "").split(";")[0] || "").trim().toLowerCase();
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
