import { resetActiveGeminiCookieForTest } from "../../../../../src/gemini/cookies";
import { resetGeminiUploadCachesForTest } from "../../../../../src/gemini/uploads/tokens";
import {
	createRuntimeConfig,
	getConfig,
	type RuntimeConfig,
} from "../../../../../src/config";
import { assert } from "../../../assertions.js";

export type UploadRequestInit = RequestInit & {
	headers: Record<string, string>;
};
type ExpectedMultipartRequest = {
	pushId?: string;
	filename: string;
	mime: string;
	bodyText?: string;
};

export function baseUploadConfig(
	overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
	return {
		...createRuntimeConfig(getConfig()),
		gemini_origin: "https://gemini.example",
		cookie: "",
		sapisid: "",
		request_timeout_sec: 180,
		upstream_socket: false,
		log_requests: false,
		generic_file_upload_max_bytes: 1024,
		...overrides,
	};
}

export function accountUploadConfig(
	accountId: string,
	cookieHash: string,
): RuntimeConfig {
	return baseUploadConfig({
		cookie: `__Secure-1PSID=psid-${accountId}; __Secure-1PSIDTS=ts-${accountId}`,
		gemini_account: {
			accountId,
			cookieHash,
		},
	});
}

export function resetUploadState() {
	resetActiveGeminiCookieForTest();
	resetGeminiUploadCachesForTest();
}

export async function assertMultipartRequest(
	init: UploadRequestInit,
	expected: ExpectedMultipartRequest,
): Promise<string> {
	const text = await multipartRequestText(init);
	if (expected.pushId !== undefined) {
		assert.equal(init.headers["Push-ID"], expected.pushId);
	}
	assert.match(
		text,
		new RegExp(`name="file"; filename="${escapeRegExp(expected.filename)}"`),
	);
	assert.match(
		text,
		new RegExp(`Content-Type: ${escapeRegExp(expected.mime)}`),
	);
	if (expected.bodyText !== undefined) {
		assert.match(text, new RegExp(escapeRegExp(expected.bodyText)));
	}
	return text;
}

export async function multipartRequestText(
	init: UploadRequestInit,
): Promise<string> {
	assert.equal(init.method, "POST");
	assert.equal(init.headers["X-Tenant-Id"], "bard-storage");
	assert.equal(init.headers.Cookie, undefined);
	assert.equal(init.headers.Authorization, undefined);
	assert.match(
		init.headers["Content-Type"],
		/^multipart\/form-data; boundary=/,
	);
	const text = new TextDecoder().decode(await bodyBytes(init.body));
	return text;
}

export async function bodyBytes(
	body: BodyInit | null | undefined,
): Promise<Uint8Array> {
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}
	return new Response(body).bytes();
}

function escapeRegExp(value: unknown): string {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
