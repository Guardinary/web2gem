import type { RuntimeConfig } from "../../config";
import { sanitizeUploadFilename } from "../../attachments/mime";
import { TEXT_ENCODER } from "../../shared/encoding";
import { bytesToHex } from "../../shared/crypto";
import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import { contentPushUploadError, validateContentPushFileRef } from "./errors";
import {
	contentPushUploadTokens,
	getGeminiPushId,
	refreshGeminiPushId,
} from "./tokens";

export type UploadBytesInput = {
	bytes: Uint8Array;
	mime: string;
	filename: string;
};

const MULTIPART_UPLOAD_ENDPOINT = "https://content-push.googleapis.com/upload";

type MultipartFileBody = {
	body: BodyInit;
	contentType: string;
	boundary: string;
	contentLength: number;
};

export async function uploadMultipartFile(
	cfg: RuntimeConfig,
	input: UploadBytesInput,
): Promise<string> {
	return uploadMultipartFileWithPushId(
		cfg,
		input,
		await getGeminiPushId(cfg),
		false,
	);
}

async function uploadMultipartFileWithPushId(
	cfg: RuntimeConfig,
	input: UploadBytesInput,
	pushId: string,
	retriedAfterRefresh: boolean,
): Promise<string> {
	const tokens = contentPushUploadTokens(pushId, "multipart");
	const multipart = buildMultipartFileBody(input);
	const headers: Record<string, string> = {
		Origin: "https://gemini.google.com",
		Referer: "https://gemini.google.com/",
		"X-Tenant-Id": "bard-storage",
		"Push-ID": tokens.pushId,
		"User-Agent": GEMINI_WEB_USER_AGENT,
		"Content-Type": multipart.contentType,
	};
	const response = await httpFetch(MULTIPART_UPLOAD_ENDPOINT, {
		method: "POST",
		headers,
		body: multipart.body,
		bodyLength: multipart.contentLength,
		timeoutMs: 60000,
		socket: cfg.upstream_socket,
		cfg,
	});
	if (!response.ok) {
		if (
			!retriedAfterRefresh &&
			shouldRefreshPushIdAfterStatus(response.status)
		) {
			const refreshedPushId = await refreshGeminiPushId(cfg);
			if (refreshedPushId && refreshedPushId !== tokens.pushId) {
				return uploadMultipartFileWithPushId(cfg, input, refreshedPushId, true);
			}
		}
		throw contentPushUploadError(
			"content_push_http_status",
			`multipart upload failed with HTTP ${response.status}`,
			{
				status: response.status,
				protocol: "multipart",
			},
		);
	}
	return validateContentPushFileRef(await response.text(), "multipart");
}

function shouldRefreshPushIdAfterStatus(status: unknown): boolean {
	const code = Number(status);
	return code === 401 || code === 403 || code === 415;
}

export function buildMultipartFileBody(
	input: UploadBytesInput,
): MultipartFileBody {
	const boundary = `----web2gem-${randomBoundarySuffix()}`;
	const filename = escapeMultipartFilename(input.filename || "upload.bin");
	const mime =
		String(input.mime || "application/octet-stream")
			.replace(/[\r\n]/g, "")
			.trim() || "application/octet-stream";
	const head = TEXT_ENCODER.encode(
		[
			`--${boundary}`,
			`Content-Disposition: form-data; name="file"; filename="${filename}"`,
			`Content-Type: ${mime}`,
			"",
			"",
		].join("\r\n"),
	);
	const tail = TEXT_ENCODER.encode(`\r\n--${boundary}--\r\n`);
	const contentLength =
		head.byteLength + input.bytes.byteLength + tail.byteLength;
	return {
		body: multipartByteStream([head, input.bytes, tail], contentLength),
		contentType: `multipart/form-data; boundary=${boundary}`,
		boundary,
		contentLength,
	};
}

function multipartByteStream(
	chunks: readonly Uint8Array[],
	contentLength: number,
): BodyInit {
	if (typeof FixedLengthStream === "function") {
		const stream = new FixedLengthStream(contentLength);
		void writeMultipartChunks(stream.writable, chunks);
		return stream.readable;
	}
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				if (chunk.byteLength) controller.enqueue(chunk);
			}
			controller.close();
		},
	});
}

async function writeMultipartChunks(
	writable: WritableStream<Uint8Array>,
	chunks: readonly Uint8Array[],
): Promise<void> {
	const writer = writable.getWriter();
	try {
		for (const chunk of chunks) {
			if (chunk.byteLength) await writer.write(chunk);
		}
		await writer.close();
	} catch (e) {
		try {
			await writer.abort(e);
		} catch (_) {}
	} finally {
		try {
			writer.releaseLock();
		} catch (_) {}
	}
}

function escapeMultipartFilename(filename: string): string {
	const safe = sanitizeUploadFilename(filename) || "upload.bin";
	return safe.replace(/\\/g, "_").replace(/"/g, "_");
}

function randomBoundarySuffix(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return bytesToHex(bytes);
}
