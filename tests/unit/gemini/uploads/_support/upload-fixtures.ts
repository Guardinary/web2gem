// @ts-nocheck
import { resetActiveGeminiCookieForTest } from "../../../../../src/gemini/cookies";
import { resetGeminiUploadCachesForTest } from "../../../../../src/gemini/uploads/tokens";
import { assert } from "../../../assertions.js";

export function baseUploadConfig(overrides = {}) {
	return {
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

export function accountUploadConfig(accountId, cookieHash) {
	return baseUploadConfig({
		cookie: `__Secure-1PSID=psid-${accountId}; __Secure-1PSIDTS=ts-${accountId}`,
		gemini_account: {
			accountId,
			rowId: `row-${accountId}`,
			cookieHash,
		},
	});
}

export function resetUploadState() {
	resetActiveGeminiCookieForTest();
	resetGeminiUploadCachesForTest();
}

export async function assertMultipartRequest(init, expected) {
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

export async function multipartRequestText(init) {
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

export async function bodyBytes(body) {
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}
	return new Response(body).bytes();
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
