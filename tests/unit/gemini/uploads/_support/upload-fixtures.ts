import {
	createRuntimeConfig,
	getConfig,
	type RuntimeConfig,
} from "../../../../../src/config";
import { resetActiveGeminiCookieForTest } from "../../../../../src/gemini/cookies";
import { resetGeminiUploadCachesForTest } from "../../../../../src/gemini/uploads/tokens";
import { assert } from "../../../assertions.js";

type UploadRequestInit = RequestInit & {
	headers: Record<string, string>;
};
type ExpectedMultipartRequest = {
	pushId?: string;
	filename: string;
	mime: string;
	bodyText?: string;
};
type PushIdCacheWriter = {
	put(request: Request, response: Response): Promise<void>;
};
type UploadRouteHandler = (
	init: UploadRequestInit,
) => Response | Promise<Response>;
type UploadFetchHandlers = {
	app?: UploadRouteHandler;
	contentPush?: UploadRouteHandler;
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

function pushIdCacheRequest(cfg: RuntimeConfig): Request {
	const origin = (cfg.gemini_origin || "https://gemini.google.com").replace(
		/\/$/,
		"",
	);
	const account = cfg.gemini_account;
	const scope = account
		? `${origin}\x00account:${account.accountId || ""}\x00cookie:${account.cookieHash || ""}`
		: origin;
	return new Request(
		`https://internal-cache/gemini-push-id/${encodeURIComponent(scope)}`,
	);
}

export async function seedCachedPushId(
	cache: PushIdCacheWriter,
	cfg: RuntimeConfig,
	pushId: string,
	createdAtMs = Date.now(),
): Promise<void> {
	await cache.put(
		pushIdCacheRequest(cfg),
		new Response(
			JSON.stringify({ push_id: pushId, created_at_ms: createdAtMs }),
		),
	);
}

export function createUploadFetchRouter(handlers: UploadFetchHandlers): {
	requests: string[];
	fetch: (
		url: RequestInfo | URL,
		init?: UploadRequestInit,
	) => Promise<Response>;
} {
	const requests: string[] = [];
	return {
		requests,
		async fetch(url, init = { headers: {} }) {
			const href = String(url);
			requests.push(href);
			let handler: UploadRouteHandler | undefined;
			if (href === "https://gemini.example/app") handler = handlers.app;
			else if (href === "https://content-push.googleapis.com/upload")
				handler = handlers.contentPush;
			if (!handler) throw new Error(`unexpected fetch ${href}`);
			return handler(init);
		},
	};
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
