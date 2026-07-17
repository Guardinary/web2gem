import { beforeEach, describe, test } from "vitest";
import { base64ToBytes } from "../../src/attachments/base64";
import {
	openAIAttachmentPlanFromRequest,
	requestAttachmentPlanFromChannels,
} from "../../src/promptcompat/attachment-inputs";
import { parseOpenAIMessages } from "../../src/promptcompat/message-model";
import { parseUploadUrl } from "../../src/attachments/input";
import {
	attachmentDrop,
	droppedAttachmentNote,
} from "../../src/attachments/notes";
import { createAttachmentPlan } from "../../src/attachments/plan";
import { geminiAccountCacheScope } from "../../src/gemini/cache";
import { mapWithConcurrencyAndWeight } from "../../src/gemini/concurrency";
import { resetActiveGeminiCookieForTest } from "../../src/gemini/cookies";
import {
	attachmentDedupeKeyForTest,
	resolveFiles,
	resolveImages,
	uploadImage,
	uploadTextFile,
} from "../../src/gemini/uploads/execute";
import { buildMultipartFileBody } from "../../src/gemini/uploads/multipart";
import {
	getCachedGeminiPushId,
	getFreshPageTokensForConfig,
	getGeminiPushId,
	getPageTokens,
	resetGeminiUploadCachesForTest,
	setCachedGeminiPushId,
} from "../../src/gemini/uploads/tokens";
import { assert } from "./assertions.js";
import {
	createMemoryCache,
	resetTestState,
	withCaches,
	withConsoleLog,
	withFetch,
	withPatchedGlobal,
} from "./helpers.js";

async function withoutTypedArrayEncodingMethods(run) {
	const fromBase64Descriptor = Object.getOwnPropertyDescriptor(
		Uint8Array,
		"fromBase64",
	);
	const toBase64Descriptor = Object.getOwnPropertyDescriptor(
		Uint8Array.prototype,
		"toBase64",
	);
	Object.defineProperty(Uint8Array, "fromBase64", {
		value: undefined,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(Uint8Array.prototype, "toBase64", {
		value: undefined,
		configurable: true,
		writable: true,
	});
	try {
		return await run();
	} finally {
		if (fromBase64Descriptor)
			Object.defineProperty(Uint8Array, "fromBase64", fromBase64Descriptor);
		else delete Uint8Array.fromBase64;
		if (toBase64Descriptor)
			Object.defineProperty(
				Uint8Array.prototype,
				"toBase64",
				toBase64Descriptor,
			);
		else delete Uint8Array.prototype.toBase64;
	}
}
function baseUploadCfg(overrides = {}) {
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
function accountUploadCfg(accountId, cookieHash) {
	return baseUploadCfg({
		cookie: `__Secure-1PSID=psid-${accountId}; __Secure-1PSIDTS=ts-${accountId}`,
		gemini_account: {
			accountId,
			rowId: `row-${accountId}`,
			cookieHash,
		},
	});
}
async function assertPreferredMultipart(init, expected) {
	assert.equal(init.method, "POST");
	assert.equal(init.headers["X-Tenant-Id"], "bard-storage");
	assert.equal(init.headers.Cookie, undefined);
	assert.equal(init.headers.Authorization, undefined);
	assert.match(
		init.headers["Content-Type"],
		/^multipart\/form-data; boundary=/,
	);
	const text = new TextDecoder().decode(await bodyBytes(init.body));
	assert.match(
		text,
		new RegExp(`name="file"; filename="${escapeRegExp(expected.filename)}"`),
	);
	assert.match(
		text,
		new RegExp(`Content-Type: ${escapeRegExp(expected.mime)}`),
	);
	if (expected.bodyText !== undefined)
		assert.match(text, new RegExp(escapeRegExp(expected.bodyText)));
}
async function bodyBytes(body) {
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body))
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	return new Response(body).bytes();
}
function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("uploads", () => {
	beforeEach(resetTestState);
	test("returns empty attachment resolution without fetching tokens", async () => {
		await withFetch(
			async (url) => {
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				const result = await resolveFiles(baseUploadCfg(), []);
				assert.equal(result.fileRefs, null);
				assert.equal(result.droppedNote, "");
				assert.equal(result.usage.uploadedFiles, 0);
			},
		);
	});
	test("uses deterministic default messages for attachment drop reasons", async () => {
		const reasons = [
			["image", "invalid_image_input", "invalid image input"],
			["file", "invalid_file_input", "invalid file input"],
			["file", "invalid_base64", "invalid base64 payload"],
			["file", "invalid_remote_url", "invalid remote URL"],
			["file", "file_too_large", "file attachment is too large"],
			["image", "image_too_large", "image attachment is too large"],
			["file", "too_many_files", "too many attachments"],
			["file", "upload_failed", "attachment upload failed"],
		];

		for (const [kind, code, message] of reasons) {
			assert.equal(attachmentDrop(kind, code).message, message);
		}
	});
	test("groups dropped attachment notes by kind and message", async () => {
		const drops = [
			attachmentDrop(
				"file",
				"invalid_base64",
				undefined,
				"../bad\u0000\r\nname.txt",
			),
			attachmentDrop("file", "invalid_base64"),
			attachmentDrop("image", "too_many_files", "custom limit"),
			attachmentDrop("image", "too_many_files", "custom limit"),
		];

		assert.equal(drops[0].filename, "bad  name.txt");
		assert.equal(
			droppedAttachmentNote(drops),
			"\n\n[Note: 2 file(s) were provided but ignored - invalid base64 payload.]" +
				"\n\n[Note: 2 image(s) were provided but ignored - custom limit.]",
		);
	});
	test("decodes base64 through the native Uint8Array runtime", async () => {
		assert.deepEqual(
			Array.from(base64ToBytes("aGVsbG8")),
			[104, 101, 108, 108, 111],
		);
		assert.deepEqual(Array.from(base64ToBytes("-_8")), [251, 255]);
		for (const invalid of ["not base64!?", "a===", "aGV=sbG8", "A"]) {
			assert.throws(() => base64ToBytes(invalid), /invalid base64 payload/);
		}
	});
	test("decodes and encodes base64 without TypedArray runtime helpers", async () => {
		await withoutTypedArrayEncodingMethods(async () => {
			assert.deepEqual(
				Array.from(base64ToBytes("aGVsbG8")),
				[104, 101, 108, 108, 111],
			);
			assert.deepEqual(Array.from(base64ToBytes("-_8")), [251, 255]);
			assert.throws(() => base64ToBytes("aGV=sbG8"), /invalid base64 payload/);
			assert.deepEqual(parseUploadUrl("data:text/plain,hello"), {
				b64: "aGVsbG8=",
				mime: "text/plain",
			});
		});
	});
	test("uploads direct images through preferred multipart without content-push auth", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const requests = [];
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				requests.push({ href, init });
				if (href === "https://gemini.example/app") {
					return new Response('{"qKIAYe":"push-direct"}', { status: 200 });
				}
				if (href === "https://content-push.googleapis.com/upload") {
					await assertPreferredMultipart(init, {
						filename: "image.jpg",
						mime: "image/jpeg",
					});
					return new Response("/uploaded/direct-image-ref", { status: 200 });
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				const ref = await uploadImage(
					baseUploadCfg({
						cookie: "__Secure-1PSID=psid; SAPISID=sapi",
						sapisid: "sapi",
					}),
					new Uint8Array([1, 2]),
					"image/jpeg",
				);
				assert.equal(ref, "/uploaded/direct-image-ref");
			},
		);
		assert.deepEqual(
			requests.map((request) => request.href),
			[
				"https://gemini.example/app",
				"https://content-push.googleapis.com/upload",
			],
		);
	});
	test("builds multipart bodies with fixed content length streams", async () => {
		const lengths = [];
		class FakeFixedLengthStream {
			constructor(length) {
				lengths.push(length);
				const stream = new TransformStream();
				this.readable = stream.readable;
				this.writable = stream.writable;
			}
		}

		await withPatchedGlobal(
			"FixedLengthStream",
			FakeFixedLengthStream,
			async () => {
				const multipart = buildMultipartFileBody({
					bytes: new Uint8Array([65, 66, 67]),
					mime: " text/plain\r\n ",
					filename: 'bad"name.txt',
				});
				const bytes = await bodyBytes(multipart.body);
				const text = new TextDecoder().decode(bytes);

				assert.deepEqual(lengths, [multipart.contentLength]);
				assert.equal(bytes.byteLength, multipart.contentLength);
				assert.match(
					multipart.contentType,
					/^multipart\/form-data; boundary=----web2gem-/,
				);
				assert.match(text, new RegExp(`--${escapeRegExp(multipart.boundary)}`));
				assert.match(text, /name="file"; filename="bad_name\.txt"/);
				assert.match(text, /Content-Type: text\/plain/);
				assert.match(text, /\r\n\r\nABC\r\n/);
				assert.match(
					text,
					new RegExp(`--${escapeRegExp(multipart.boundary)}--\\r\\n$`),
				);
			},
		);
	});
	test("caches Gemini push IDs in the Workers cache API", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const cfg = baseUploadCfg({ cookie: "__Secure-1PSID=psid" });
		const cache = createMemoryCache();
		await withCaches(cache, async () => {
			assert.equal(await getCachedGeminiPushId(cfg), "");
			await setCachedGeminiPushId(cfg, "push-cached");
			assert.equal(await getCachedGeminiPushId(cfg), "push-cached");
			assert.equal(cache.stats.match, 1);

			resetGeminiUploadCachesForTest();
			assert.equal(await getCachedGeminiPushId(cfg), "push-cached");
			assert.equal(cache.stats.match, 2);
		});
	});
	test("persists Gemini push IDs with waitUntil when available", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const cfg = baseUploadCfg({ cookie: "__Secure-1PSID=psid" });
		const cache = createMemoryCache();
		const pending = [];
		await withCaches(cache, async () => {
			await setCachedGeminiPushId(
				{
					...cfg,
					execution_ctx: {
						waitUntil(promise) {
							pending.push(promise);
						},
					},
				},
				"push-waituntil",
			);
			assert.equal(await getCachedGeminiPushId(cfg), "push-waituntil");
			assert.equal(cache.stats.match, 0);
			assert.equal(pending.length, 1);
			await Promise.all(pending);
			assert.equal(cache.stats.put, 1);
		});
	});
	test("scopes Gemini push ID cache by account context when present", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const cfgA = accountUploadCfg("account-a", "hash-a");
		const cfgB = accountUploadCfg("account-b", "hash-b");
		const cache = createMemoryCache();
		await withCaches(cache, async () => {
			await setCachedGeminiPushId(cfgA, "push-a");
			await setCachedGeminiPushId(cfgB, "push-b");
			resetGeminiUploadCachesForTest();
			assert.equal(await getCachedGeminiPushId(cfgA), "push-a");
			assert.equal(await getCachedGeminiPushId(cfgB), "push-b");
			assert.equal(
				geminiAccountCacheScope(cfgA) === geminiAccountCacheScope(cfgB),
				false,
			);
			assert.doesNotMatch(
				geminiAccountCacheScope(cfgA),
				/psid-account-a|ts-account-a/,
			);
		});
	});
	test("drops stale cached Gemini push IDs", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const cfg = baseUploadCfg();
		const cache = createMemoryCache();
		await cache.put(
			new Request(
				`https://internal-cache/gemini-push-id/${encodeURIComponent("https://gemini.example")}`,
			),
			new Response(
				JSON.stringify({
					push_id: "stale-push-id",
					created_at_ms: Date.now() - 13 * 60 * 60 * 1000,
				}),
			),
		);
		await withCaches(cache, async () => {
			assert.equal(await getCachedGeminiPushId(cfg), "");
			assert.equal(await getCachedGeminiPushId(cfg), "");
			assert.equal(cache.stats.delete, 1);
		});
	});
	test("refreshes Gemini push IDs once for concurrent callers", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const cfg = baseUploadCfg({ cookie: "SID=ok" });
		const cache = createMemoryCache();
		let calls = 0;
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		await withCaches(cache, async () => {
			await withFetch(
				async (url, init = {}) => {
					calls += 1;
					assert.equal(String(url), "https://gemini.example/app");
					assert.equal(init.headers.Cookie, "SID=ok");
					await gate;
					return new Response('{"qKIAYe":"push-fresh"}', { status: 200 });
				},
				async () => {
					const first = getGeminiPushId(cfg);
					const second = getGeminiPushId(cfg);
					release();
					assert.deepEqual(await Promise.all([first, second]), [
						"push-fresh",
						"push-fresh",
					]);
					assert.equal(calls, 1);
					assert.equal(await getCachedGeminiPushId(cfg), "push-fresh");
				},
			);
		});
	});
	test("uses cached Gemini push ID for multipart uploads without fetching the app page", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const cache = createMemoryCache();
		const requests = [];
		await withCaches(cache, async () => {
			await setCachedGeminiPushId(baseUploadCfg(), "push-upload-cache");
			resetGeminiUploadCachesForTest();
			await withFetch(
				async (url, init = {}) => {
					const href = String(url);
					requests.push(href);
					if (href === "https://content-push.googleapis.com/upload") {
						await assertPreferredMultipart(init, {
							filename: "message.txt",
							mime: "text/plain; charset=utf-8",
							bodyText: "hello",
						});
						assert.equal(init.headers["Push-ID"], "push-upload-cache");
						return new Response("/uploaded/cached-text-ref", { status: 200 });
					}
					throw new Error(`unexpected fetch ${href}`);
				},
				async () => {
					const ref = await uploadTextFile(
						baseUploadCfg({ cookie: "__Secure-1PSID=psid" }),
						"hello",
						"message.txt",
					);
					assert.deepEqual(ref, {
						ref: "/uploaded/cached-text-ref",
						name: "message.txt",
					});
				},
			);
		});
		assert.deepEqual(requests, ["https://content-push.googleapis.com/upload"]);
	});
	test("refreshes stale cached Gemini push IDs after upload token rejection", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const cache = createMemoryCache();
		const requests = [];
		const pushIds = [];
		await withCaches(cache, async () => {
			await setCachedGeminiPushId(baseUploadCfg(), "push-stale");
			resetGeminiUploadCachesForTest();
			await withFetch(
				async (url, init = {}) => {
					const href = String(url);
					requests.push(href);
					if (href === "https://content-push.googleapis.com/upload") {
						pushIds.push(init.headers["Push-ID"]);
						await assertPreferredMultipart(init, {
							filename: "message.txt",
							mime: "text/plain; charset=utf-8",
							bodyText: "hello",
						});
						return pushIds.length === 1
							? new Response("stale token", { status: 415 })
							: new Response("/uploaded/refreshed-text-ref", { status: 200 });
					}
					if (href === "https://gemini.example/app") {
						return new Response('{"qKIAYe":"push-fresh"}', { status: 200 });
					}
					throw new Error(`unexpected fetch ${href}`);
				},
				async () => {
					const ref = await uploadTextFile(
						baseUploadCfg({ cookie: "__Secure-1PSID=psid" }),
						"hello",
						"message.txt",
					);
					assert.deepEqual(ref, {
						ref: "/uploaded/refreshed-text-ref",
						name: "message.txt",
					});
				},
			);
			assert.equal(await getCachedGeminiPushId(baseUploadCfg()), "push-fresh");
		});
		assert.deepEqual(requests, [
			"https://content-push.googleapis.com/upload",
			"https://gemini.example/app",
			"https://content-push.googleapis.com/upload",
		]);
		assert.deepEqual(pushIds, ["push-stale", "push-fresh"]);
	});
	test("does not cache page-token fetch failures as successful empty token results", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		let appCalls = 0;
		await withFetch(
			async (url) => {
				const href = String(url);
				if (href === "https://gemini.example/app") {
					appCalls += 1;
					throw new Error("app unavailable");
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				assert.deepEqual(await getPageTokens(baseUploadCfg()), {});
				assert.deepEqual(await getPageTokens(baseUploadCfg()), {});
			},
		);
		assert.equal(appCalls, 2);
	});
	test("bypasses the page-token cache for forced Gemini session verification", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		let appCalls = 0;
		const cfg = baseUploadCfg({ cookie: "__Secure-1PSID=psid" });
		await withFetch(
			async (url) => {
				if (String(url) !== "https://gemini.example/app")
					throw new Error(`unexpected fetch ${url}`);
				appCalls += 1;
				return new Response(`{"SNlM0e":"at-${appCalls}"}`, { status: 200 });
			},
			async () => {
				assert.deepEqual(await getPageTokens(cfg), { at: "at-1" });
				assert.deepEqual(await getPageTokens(cfg), { at: "at-1" });
				assert.deepEqual(await getFreshPageTokensForConfig(cfg), {
					at: "at-2",
				});
			},
		);
		assert.equal(appCalls, 2);
	});
	test("scopes Gemini page tokens by account context", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const cfgA = accountUploadCfg("account-a", "hash-a");
		const cfgB = accountUploadCfg("account-b", "hash-b");
		const appCookies = [];
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				if (href === "https://gemini.example/app") {
					appCookies.push(init.headers.Cookie);
					if (init.headers.Cookie.includes("psid-account-a")) {
						return new Response('{"SNlM0e":"at-a","qKIAYe":"push-a"}', {
							status: 200,
						});
					}
					if (init.headers.Cookie.includes("psid-account-b")) {
						return new Response('{"SNlM0e":"at-b","qKIAYe":"push-b"}', {
							status: 200,
						});
					}
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				assert.deepEqual(await getPageTokens(cfgA), {
					at: "at-a",
					push_id: "push-a",
				});
				assert.deepEqual(await getPageTokens(cfgB), {
					at: "at-b",
					push_id: "push-b",
				});
				assert.deepEqual(await getPageTokens(cfgA), {
					at: "at-a",
					push_id: "push-a",
				});
			},
		);
		assert.deepEqual(appCookies, [
			"__Secure-1PSID=psid-account-a; __Secure-1PSIDTS=ts-account-a",
			"__Secure-1PSID=psid-account-b; __Secure-1PSIDTS=ts-account-b",
			"__Secure-1PSID=psid-account-a; __Secure-1PSIDTS=ts-account-a",
		]);
	});
	test("rejects content-push upload when app page markers are missing", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				withFetch(
					async (url) => {
						const href = String(url);
						if (href === "https://gemini.example/app")
							return new Response("no token markers", { status: 200 });
						throw new Error(`unexpected fetch ${href}`);
					},
					async () => {
						await assert.rejects(
							() =>
								uploadTextFile(
									baseUploadCfg({
										cookie: "__Secure-1PSID=psid",
										log_requests: true,
									}),
									"hello",
									"message.txt",
								),
							/missing Gemini page token/,
						);
					},
				),
		);
		assert.equal(
			logs.some((line) => line.includes("app page push_id marker missing")),
			true,
		);
		assert.equal(
			logs.some((line) => line.includes("default page token")),
			false,
		);
	});
	test("degrades anonymous images instead of passing file refs to generation", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		await withFetch(
			async (url) => {
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				const result = await resolveImages(baseUploadCfg(), [
					{
						b64: "aGVsbG8=",
						mime: "image/png",
						filename: "../unsafe name.png",
					},
				]);
				assert.equal(result.fileRefs, null);
				assert.equal(result.imageFileRefs, null);
				assert.equal(result.supportsFileRefs, false);
				assert.match(
					result.droppedNote,
					/image input requires a configured Gemini account pool/,
				);
				assert.equal(result.usage.uploadedFiles, 0);
			},
		);
	});
	test("inlines anonymous text files instead of uploading unusable file refs", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		await withFetch(
			async (url) => {
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				const result = await resolveFiles(baseUploadCfg(), [
					{ b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
					{ b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
				]);
				assert.equal(result.fileRefs, null);
				assert.equal(result.supportsFileRefs, false);
				assert.match(
					result.promptText,
					/\[File attachment: same\.txt\]\nhello\n\[\/File attachment\]/,
				);
				assert.equal(
					(result.promptText.match(/\[File attachment/g) || []).length,
					1,
				);
				assert.equal(result.usage.uploadedFiles, 0);
				assert.equal(result.usage.inlinedFiles, 1);
				assert.equal(result.usage.dedupedFiles, 1);
			},
		);
	});
	test("deduplicates identical cookie-backed request-local attachments while preserving references", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		let uploadCalls = 0;
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				if (href === "https://gemini.example/app")
					return new Response('{"qKIAYe":"push-dedupe"}', { status: 200 });
				if (href === "https://content-push.googleapis.com/upload") {
					uploadCalls += 1;
					await assertPreferredMultipart(init, {
						filename: "same.txt",
						mime: "text/plain",
						bodyText: "hello",
					});
					return new Response("/uploaded/same", { status: 200 });
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				const result = await resolveFiles(
					baseUploadCfg({ cookie: "__Secure-1PSID=psid" }),
					[
						{ b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
						{ b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
					],
				);
				assert.deepEqual(result.fileRefs, [
					{ ref: "/uploaded/same", name: "same.txt" },
					{ ref: "/uploaded/same", name: "same.txt" },
				]);
				assert.equal(result.supportsFileRefs, true);
				assert.equal(result.usage.uploadedFiles, 1);
				assert.equal(result.usage.dedupedFiles, 1);
			},
		);
		assert.equal(uploadCalls, 1);
	});
	test("keeps MIME and filename in attachment dedupe identity", async () => {
		const bytes = new TextEncoder().encode("same payload");
		const base = {
			candidate: {},
			bytes,
			mime: "text/plain",
			filename: "a.txt",
		};
		const same = await attachmentDedupeKeyForTest(base);
		assert.equal(await attachmentDedupeKeyForTest({ ...base }), same);
		assert.equal(
			(await attachmentDedupeKeyForTest({
				...base,
				mime: "text/csv",
			})) === same,
			false,
		);
		assert.equal(
			(await attachmentDedupeKeyForTest({
				...base,
				filename: "b.txt",
			})) === same,
			false,
		);
	});
	test("bounds concurrent attachment weight and lets an oversized item progress alone", async () => {
		let active = 0;
		let maxActive = 0;
		const starts = [];
		const results = await mapWithConcurrencyAndWeight(
			[6, 6, 12, 4],
			4,
			10,
			(value) => value,
			async (value, index) => {
				starts.push(index);
				active += value;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 1));
				active -= value;
				return `result-${index}`;
			},
		);
		assert.deepEqual(results, ["result-0", "result-1", "result-2", "result-3"]);
		assert.deepEqual(starts, [0, 1, 2, 3]);
		assert.equal(maxActive, 12);
	});
	test("releases attachment weight after mapper errors", async () => {
		const starts = [];
		let completedSecond = false;
		await assert.rejects(
			() =>
				mapWithConcurrencyAndWeight(
					[12, 4],
					2,
					10,
					(value) => value,
					async (_value, index) => {
						starts.push(index);
						if (index === 0) throw new Error("weighted mapper failed");
						completedSecond = true;
					},
				),
			/weighted mapper failed/,
		);
		await new Promise((resolve) => setTimeout(resolve, 1));
		assert.deepEqual(starts, [0, 1]);
		assert.equal(completedSecond, true);
	});
	test("does not auth fallback when multipart is rejected by protocol", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const seen = [];
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				seen.push({ href, init });
				if (href === "https://gemini.example/app")
					return new Response('{"qKIAYe":"push-fallback"}', { status: 200 });
				if (href === "https://content-push.googleapis.com/upload") {
					assert.equal(init.headers.Cookie, undefined);
					assert.equal(init.headers.Authorization, undefined);
					return new Response("unsupported media type", { status: 415 });
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				await assert.rejects(
					() =>
						uploadTextFile(
							baseUploadCfg({
								cookie: "__Secure-1PSID=psid; SAPISID=sapi",
								sapisid: "sapi",
							}),
							"fallback text",
							"message.txt",
						),
					/multipart upload failed with HTTP 415/,
				);
			},
		);
		assert.deepEqual(
			seen.map((item) => item.href),
			[
				"https://gemini.example/app",
				"https://content-push.googleapis.com/upload",
				"https://gemini.example/app",
			],
		);
	});
	test("does not send auth fallback after multipart returns an invalid file ref", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const seen = [];
		await withFetch(
			async (url) => {
				const href = String(url);
				seen.push(href);
				if (href === "https://gemini.example/app")
					return new Response('{"qKIAYe":"push-invalid-ref"}', {
						status: 200,
					});
				if (href === "https://content-push.googleapis.com/upload")
					return new Response("not-a-content-push-ref", { status: 200 });
				throw new Error(`unexpected fallback fetch ${href}`);
			},
			async () => {
				const result = await resolveFiles(
					baseUploadCfg({
						cookie: "__Secure-1PSID=psid; SAPISID=sapi",
						sapisid: "sapi",
					}),
					[{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" }],
				);
				assert.equal(result.fileRefs, null);
				assert.match(result.droppedNote, /attachment upload failed/);
			},
		);
		assert.deepEqual(seen, [
			"https://gemini.example/app",
			"https://content-push.googleapis.com/upload",
		]);
	});
	test("does not fetch or upload remote image URLs", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		await withFetch(
			async (url) => {
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				const result = await resolveImages(baseUploadCfg(), [
					{
						url: "https://images.example/path/remote%20image.webp?size=large",
					},
				]);
				assert.equal(result.fileRefs, null);
				assert.match(result.droppedNote, /invalid image input/);
				assert.equal(result.usage.uploadedFiles, 0);
			},
		);
	});
	test("uploads generic code files through preferred multipart when generation can consume file refs", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				if (href === "https://gemini.example/app")
					return new Response('{"qKIAYe":"push-file"}', { status: 200 });
				if (href === "https://content-push.googleapis.com/upload") {
					await assertPreferredMultipart(init, {
						filename: "main.py",
						mime: "text/x-python",
						bodyText: "print(1)\n",
					});
					return new Response("/uploaded/code-ref", { status: 200 });
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				const result = await resolveFiles(
					baseUploadCfg({ cookie: "__Secure-1PSID=psid" }),
					[
						{
							b64: "cHJpbnQoMSkK",
							mime: "text/x-python",
							filename: "../main.py",
						},
					],
				);
				assert.deepEqual(result.fileRefs, [
					{ ref: "/uploaded/code-ref", name: "main.py" },
				]);
				assert.deepEqual(result.genericFileRefs, [
					{ ref: "/uploaded/code-ref", name: "main.py" },
				]);
				assert.equal(result.droppedNote, "");
			},
		);
	});
	test("sniffs upload MIME from bytes when metadata is absent", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				if (href === "https://gemini.example/app")
					return new Response('{"qKIAYe":"push-sniff"}', { status: 200 });
				if (href === "https://content-push.googleapis.com/upload") {
					await assertPreferredMultipart(init, {
						filename: "file-1.pdf",
						mime: "application/pdf",
						bodyText: "%PDF-1.4\n",
					});
					return new Response("/uploaded/pdf-ref", { status: 200 });
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				const result = await resolveFiles(
					baseUploadCfg({ cookie: "__Secure-1PSID=psid" }),
					[{ b64: "JVBERi0xLjQK" }],
				);
				assert.deepEqual(result.fileRefs, [
					{ ref: "/uploaded/pdf-ref", name: "file-1.pdf" },
				]);
			},
		);
	});
	test("does not fetch or upload remote generic file URLs", async () => {
		await withFetch(
			async (url) => {
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				const result = await resolveFiles(baseUploadCfg(), [
					{
						type: "input_file",
						file_url: "https://files.example/src/main.ts?download=1",
						filename: "main.ts",
					},
				]);
				assert.equal(result.fileRefs, null);
				assert.match(result.droppedNote, /missing generic file upload data/);
				assert.equal(result.usage.uploadedFiles, 0);
			},
		);
	});
	test("inlines empty anonymous generic text files", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		await withFetch(
			async (url) => {
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				const result = await resolveFiles(baseUploadCfg(), [
					{
						type: "input_file",
						file_data: "",
						mime: "text/plain",
						filename: "empty.txt",
					},
				]);
				assert.equal(result.fileRefs, null);
				assert.match(
					result.promptText,
					/\[File attachment: empty\.txt\]\n\n\[\/File attachment\]/,
				);
				assert.equal(result.usage.inlinedFiles, 1);
				assert.equal(result.usage.inlinedBytes, 0);
			},
		);
	});
	test("does not fetch Google fileData fileUri as a generic upload URL", async () => {
		await withFetch(
			async (url) => {
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				const result = await resolveFiles(baseUploadCfg(), [
					{
						type: "file",
						fileData: {
							fileUri: "https://files.example/main.py",
							mimeType: "text/x-python",
							displayName: "main.py",
						},
					},
				]);
				assert.equal(result.fileRefs, null);
				assert.equal(result.droppedNote, "");
			},
		);
	});
	test("degrades invalid base64 and oversized inline files with deterministic notes", async () => {
		const invalid = await resolveFiles(baseUploadCfg(), [
			{ b64: "not base64!?", mime: "text/plain" },
		]);
		assert.equal(invalid.fileRefs, null);
		assert.match(invalid.droppedNote, /1 file\(s\).*invalid base64 payload/);

		const tooLarge = await resolveFiles(
			baseUploadCfg({ generic_file_upload_max_bytes: 2 }),
			[{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" }],
		);
		assert.equal(tooLarge.fileRefs, null);
		assert.match(
			tooLarge.droppedNote,
			/1 file\(s\).*file attachment is too large/,
		);
	});
	test("rejects oversized inline generic base64 before invoking runtime decoders", async () => {
		const original = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
		Object.defineProperty(Uint8Array, "fromBase64", {
			value() {
				throw new Error(
					"Uint8Array.fromBase64 should not be called for oversized input",
				);
			},
			configurable: true,
			writable: true,
		});
		try {
			const result = await resolveFiles(
				baseUploadCfg({ generic_file_upload_max_bytes: 2 }),
				[{ b64: "AAAA", mime: "application/octet-stream" }],
			);
			assert.equal(result.fileRefs, null);
			assert.match(result.droppedNote, /file attachment is too large/);
		} finally {
			if (original) Object.defineProperty(Uint8Array, "fromBase64", original);
			else delete Uint8Array.fromBase64;
		}
	});
	test("remote file URLs are rejected before any network read", async () => {
		await withFetch(
			async (url) => {
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				const result = await resolveFiles(
					baseUploadCfg({ generic_file_upload_max_bytes: 2 }),
					[
						{
							type: "input_file",
							file_url: "https://files.example/large.bin",
							filename: "large.bin",
						},
					],
				);
				assert.equal(result.fileRefs, null);
				assert.match(result.droppedNote, /missing generic file upload data/);
			},
		);
	});
	test("degrades anonymous binary files that cannot be safely inlined", async () => {
		resetGeminiUploadCachesForTest();
		await withFetch(
			async (url) => {
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				const result = await resolveFiles(baseUploadCfg(), [{ b64: "AA==" }]);
				assert.equal(result.fileRefs, null);
				assert.match(
					result.droppedNote,
					/file attachment requires a configured Gemini account pool/,
				);
			},
		);
	});
	test("uploads text context files through preferred multipart", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				if (href === "https://gemini.example/app")
					return new Response('{"qKIAYe":"push-text"}', { status: 200 });
				if (href === "https://content-push.googleapis.com/upload") {
					await assertPreferredMultipart(init, {
						filename: "message.txt",
						mime: "text/plain; charset=utf-8",
						bodyText: "hello",
					});
					return new Response("/uploaded/text-ref", { status: 200 });
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				const ref = await uploadTextFile(
					baseUploadCfg({
						cookie: "__Secure-1PSID=psid; SAPISID=sapi",
						sapisid: "sapi",
					}),
					"hello",
					"message.txt",
				);
				assert.deepEqual(ref, {
					ref: "/uploaded/text-ref",
					name: "message.txt",
				});
			},
		);
	});
	test("records max-file overflow as a degradable planning note", async () => {
		const files = Array.from({ length: 51 }, (_, index) => ({
			b64: "AA==",
			mime: "text/plain",
			filename: `f${index}.txt`,
		}));
		const plan = createAttachmentPlan({ files });
		assert.equal(plan.candidates.length, 50);
		assert.equal(plan.dropped.length, 1);
		assert.match(
			droppedAttachmentNote(plan.dropped),
			/exceeded maximum of 50 attachments per request/,
		);
	});
	test("classifies OpenAI request attachments without upload transport", async () => {
		const request = {
			ref_file_ids: ["file-top"],
			messages: [
				{
					role: "user",
					content: [
						{
							type: "input_file",
							data: "ZG9udA==",
							filename: "content-direct.txt",
							mime_type: "text/plain",
						},
					],
					attachments: [
						{
							type: "input_file",
							file_data: "bXNn",
							filename: "message-attach.txt",
							mime_type: "text/plain",
						},
					],
				},
			],
			attachments: [
				{
					type: "input_file",
					id: "inline-id",
					file_data: "aGVsbG8=",
					filename: "note.txt",
					mime: "text/plain",
				},
				{
					type: "input_file",
					file_id: "file-existing",
					filename: "existing.txt",
				},
				{
					type: "input_file",
					file: {
						id: "nested-inline-id",
						data: "AA==",
						filename: "nested.txt",
						mime: "application/octet-stream",
					},
				},
				{ type: "input_file", filename: "missing.txt" },
				{
					content: [
						{
							type: "input_file",
							file_data: "d3JhcA==",
							filename: "wrapped.txt",
							mime_type: "text/plain",
						},
					],
				},
				{ type: "text", text: "ignored" },
			],
		};
		const plan = openAIAttachmentPlanFromRequest(
			request,
			parseOpenAIMessages(request.messages),
		);
		assert.deepEqual(plan.existingFileRefs, [
			"file-top",
			{ id: "file-existing", name: "existing.txt" },
		]);
		assert.equal(plan.candidates.length, 5);
		assert.deepEqual(
			plan.candidates.map((candidate) => ({
				kind: candidate.kind,
				filename: candidate.filename,
				mime: candidate.mime,
				sourceType: candidate.source.type,
			})),
			[
				{
					kind: "file",
					filename: "note.txt",
					mime: "text/plain",
					sourceType: "base64",
				},
				{
					kind: "file",
					filename: "nested.txt",
					mime: "application/octet-stream",
					sourceType: "base64",
				},
				{
					kind: "file",
					filename: "wrapped.txt",
					mime: "text/plain",
					sourceType: "base64",
				},
				{
					kind: "file",
					filename: "content-direct.txt",
					mime: "text/plain",
					sourceType: "base64",
				},
				{
					kind: "file",
					filename: "message-attach.txt",
					mime: "text/plain",
					sourceType: "base64",
				},
			],
		);
		assert.deepEqual(
			plan.dropped.map((drop) => ({
				kind: drop.kind,
				code: drop.code,
				filename: drop.filename,
			})),
			[{ kind: "file", code: "invalid_file_input", filename: "missing.txt" }],
		);
	});
	test("classifies OpenAI request-level image blocks without upload transport", async () => {
		const plan = requestAttachmentPlanFromChannels({
			attachments: [
				{
					type: "image_url",
					image_url: { url: "data:image/png;base64,QUJDRA==" },
					filename: "../outer.png",
				},
				{
					type: "image_url",
					url: "data:image/gif;base64,R0lGODlh",
					filename: "direct.gif",
				},
			],
			files: [
				{
					type: "input_image",
					image_url: "data:;base64,BBBB",
					mime_type: "image/jpeg",
					filename: "inline.jpg",
				},
			],
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: {
								url: "data:image/png;base64,SHOULD_NOT_DUPLICATE==",
							},
						},
					],
				},
			],
		});
		assert.equal(plan.candidates.length, 3);
		assert.deepEqual(
			plan.candidates.map((candidate) => ({
				kind: candidate.kind,
				filename: candidate.filename,
				mime: candidate.mime,
				sourceType: candidate.source.type,
				data: candidate.source.data,
			})),
			[
				{
					kind: "image",
					filename: "outer.png",
					mime: "image/png",
					sourceType: "base64",
					data: "QUJDRA==",
				},
				{
					kind: "image",
					filename: "direct.gif",
					mime: "image/gif",
					sourceType: "base64",
					data: "R0lGODlh",
				},
				{
					kind: "image",
					filename: "inline.jpg",
					mime: "image/jpeg",
					sourceType: "base64",
					data: "BBBB",
				},
			],
		);
		assert.deepEqual(
			requestAttachmentPlanFromChannels({
				attachments: [
					{
						type: "image_url",
						image_url: { url: "data:image/webp;base64,V0VCUA==" },
						filename: "outer.webp",
					},
				],
			}).candidates.map((candidate) => ({
				b64: candidate.source.data,
				mime: candidate.mime,
				filename: candidate.filename,
			})),
			[{ b64: "V0VCUA==", mime: "image/webp", filename: "outer.webp" }],
		);
	});
	test("logs structured attachment upload usage when request logging is enabled", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				withFetch(
					async (url, init = {}) => {
						const href = String(url);
						if (href === "https://gemini.example/app")
							return new Response('{"qKIAYe":"push-log"}', { status: 200 });
						if (href === "https://content-push.googleapis.com/upload") {
							await assertPreferredMultipart(init, {
								filename: "same.txt",
								mime: "text/plain",
								bodyText: "hello",
							});
							return new Response("/uploaded/log-ref", { status: 200 });
						}
						throw new Error(`unexpected fetch ${href}`);
					},
					async () => {
						const result = await resolveFiles(
							baseUploadCfg({
								cookie: "__Secure-1PSID=psid",
								log_requests: true,
							}),
							[
								{ b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
								{ b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
							],
						);
						assert.equal(result.usage.uploadedFiles, 1);
						assert.equal(result.usage.dedupedFiles, 1);
						assert.equal(result.usage.multipartUploads, 1);
					},
				),
		);
		const stageLog =
			logs.find((line) => line.includes("stage=attachment_upload")) || "";
		assert.match(stageLog, /candidates=2/);
		assert.match(stageLog, /uploadedFiles=1/);
		assert.match(stageLog, /dedupedFiles=1/);
		assert.match(stageLog, /uploadedBytes=5/);
		assert.match(stageLog, /multipartUploads=1/);
	});
	test("logs multipart rejection as dropped request-local attachment", async () => {
		resetActiveGeminiCookieForTest();
		resetGeminiUploadCachesForTest();
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				withFetch(
					async (url, init = {}) => {
						const href = String(url);
						if (href === "https://gemini.example/app")
							return new Response('{"qKIAYe":"push-log-fallback"}', {
								status: 200,
							});
						if (href === "https://content-push.googleapis.com/upload") {
							await assertPreferredMultipart(init, {
								filename: "fallback.txt",
								mime: "text/plain",
								bodyText: "hello",
							});
							return new Response("unsupported media type", { status: 415 });
						}
						throw new Error(`unexpected fetch ${href}`);
					},
					async () => {
						const result = await resolveFiles(
							baseUploadCfg({
								cookie: "__Secure-1PSID=psid; SAPISID=sapi",
								sapisid: "sapi",
								log_requests: true,
							}),
							[
								{
									b64: "aGVsbG8=",
									mime: "text/plain",
									filename: "fallback.txt",
								},
							],
						);
						assert.equal(result.fileRefs, null);
						assert.match(result.droppedNote, /attachment upload failed/);
						assert.equal(result.usage.uploadedFiles, 0);
						assert.equal(result.usage.multipartUploads, 0);
						assert.equal(result.usage.droppedFiles, 1);
					},
				),
		);
		const stageLog =
			logs.find((line) => line.includes("stage=attachment_upload")) || "";
		assert.match(stageLog, /multipartUploads=0/);
		assert.match(stageLog, /droppedFiles=1/);
	});
});
