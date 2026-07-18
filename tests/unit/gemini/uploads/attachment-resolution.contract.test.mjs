import { afterEach, beforeEach, describe, test } from "vitest";
import { createAttachmentPlan } from "../../../../src/attachments/plan";
import { resolveAttachments } from "../../../../src/gemini/uploads/execute";
import { assert } from "../../assertions.js";
import { deferred } from "../../_support/deferred.js";
import { withConsoleLog, withFetch } from "../../_support/globals.js";
import {
	assertMultipartRequest,
	baseUploadConfig,
	multipartRequestText,
	resetUploadState,
} from "./_support/upload-fixtures.js";

describe("AttachmentPlan to Gemini resolution", () => {
	beforeEach(resetUploadState);
	afterEach(resetUploadState);

	test("resolves empty and pre-dropped plans without network access", async () => {
		await withFetch(
			async (url) => {
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				const empty = await resolveAttachments(
					baseUploadConfig(),
					createAttachmentPlan(),
				);
				assert.deepEqual(empty, {
					fileRefs: null,
					imageFileRefs: null,
					genericFileRefs: null,
					promptText: "",
					droppedNote: "",
					supportsFileRefs: false,
					usage: {
						uploadedFiles: 0,
						dedupedFiles: 0,
						uploadedBytes: 0,
						fileRefBytes: 0,
						inlinedFiles: 0,
						inlinedBytes: 0,
						droppedFiles: 0,
						multipartUploads: 0,
					},
				});

				const remoteOnly = createAttachmentPlan({
					files: [
						{
							type: "input_file",
							file_url: "https://files.example/remote.bin",
							filename: "remote.bin",
						},
					],
				});
				const dropped = await resolveAttachments(
					baseUploadConfig(),
					remoteOnly,
				);
				assert.equal(dropped.fileRefs, null);
				assert.match(dropped.droppedNote, /missing generic file upload data/);
				assert.equal(dropped.usage.droppedFiles, 1);
				assert.equal(dropped.usage.uploadedFiles, 0);
			},
		);
	});

	test("inlines anonymous text while degrading images and binary files", async () => {
		const plan = createAttachmentPlan({
			images: [
				{
					b64: "aW1hZ2U=",
					mime: "image/png",
					filename: "../unsafe.png",
				},
			],
			files: [
				{ b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
				{ b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
				{ b64: "", mime: "text/plain", filename: "empty.txt" },
				{
					b64: "AA==",
					mime: "application/octet-stream",
					filename: "binary.bin",
				},
			],
		});

		await withFetch(
			async (url) => {
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				const result = await resolveAttachments(baseUploadConfig(), plan);
				assert.equal(result.fileRefs, null);
				assert.equal(result.imageFileRefs, null);
				assert.equal(result.genericFileRefs, null);
				assert.equal(result.supportsFileRefs, false);
				assert.equal(
					result.promptText,
					"\n\n[File attachment: same.txt]\nhello\n[/File attachment]" +
						"\n\n[File attachment: empty.txt]\n\n[/File attachment]",
				);
				assert.match(
					result.droppedNote,
					/image input requires a configured Gemini account pool/,
				);
				assert.match(
					result.droppedNote,
					/file attachment requires a configured Gemini account pool/,
				);
				assert.deepEqual(result.usage, {
					uploadedFiles: 0,
					dedupedFiles: 1,
					uploadedBytes: 0,
					fileRefBytes: 0,
					inlinedFiles: 2,
					inlinedBytes: 5,
					droppedFiles: 2,
					multipartUploads: 0,
				});
			},
		);
	});

	test("preserves candidate order across out-of-order multipart completion", async () => {
		const releaseImage = deferred();
		const fastUploadsStarted = deferred();
		let fastUploads = 0;
		const plan = createAttachmentPlan({
			images: [
				{ b64: "aW1hZ2U=", mime: "image/jpeg", filename: "../photo.jpg" },
			],
			files: [
				{
					b64: "cHJpbnQoMSkK",
					mime: "text/x-python",
					filename: "../main.py",
				},
				{ b64: "JVBERi0xLjQK" },
			],
		});

		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				if (href === "https://gemini.example/app") {
					return new Response('{"qKIAYe":"push-mixed"}', { status: 200 });
				}
				if (href !== "https://content-push.googleapis.com/upload") {
					throw new Error(`unexpected fetch ${href}`);
				}
				assert.equal(init.headers["Push-ID"], "push-mixed");
				const text = await multipartRequestText(init);
				if (text.includes('filename="photo.jpg"')) {
					assert.match(text, /Content-Type: image\/jpeg/);
					assert.match(text, /\r\n\r\nimage\r\n/);
					await releaseImage.promise;
					return new Response("/uploaded/photo", { status: 200 });
				}
				if (text.includes('filename="main.py"')) {
					assert.match(text, /Content-Type: text\/x-python/);
					assert.match(text, /\r\n\r\nprint\(1\)\n\r\n/);
					fastUploads += 1;
					if (fastUploads === 2) fastUploadsStarted.resolve();
					return new Response("/uploaded/main", { status: 200 });
				}
				if (text.includes('filename="file-1.pdf"')) {
					assert.match(text, /Content-Type: application\/pdf/);
					assert.match(text, /\r\n\r\n%PDF-1\.4\n\r\n/);
					fastUploads += 1;
					if (fastUploads === 2) fastUploadsStarted.resolve();
					return new Response("/uploaded/pdf", { status: 200 });
				}
				throw new Error(`unexpected multipart body ${text}`);
			},
			async () => {
				const operation = resolveAttachments(
					baseUploadConfig({ cookie: "__Secure-1PSID=psid" }),
					plan,
				);
				await fastUploadsStarted.promise;
				releaseImage.resolve();
				const result = await operation;
				assert.deepEqual(result.fileRefs, [
					{ ref: "/uploaded/photo", name: "photo.jpg" },
					{ ref: "/uploaded/main", name: "main.py" },
					{ ref: "/uploaded/pdf", name: "file-1.pdf" },
				]);
				assert.deepEqual(result.imageFileRefs, [
					{ ref: "/uploaded/photo", name: "photo.jpg" },
				]);
				assert.deepEqual(result.genericFileRefs, [
					{ ref: "/uploaded/main", name: "main.py" },
					{ ref: "/uploaded/pdf", name: "file-1.pdf" },
				]);
				assert.equal(result.supportsFileRefs, true);
				assert.deepEqual(result.usage, {
					uploadedFiles: 3,
					dedupedFiles: 0,
					uploadedBytes: 23,
					fileRefBytes: 23,
					inlinedFiles: 0,
					inlinedBytes: 0,
					droppedFiles: 0,
					multipartUploads: 3,
				});
			},
		);
	});

	test("deduplicates an identical candidate while its upload is pending", async () => {
		const originalDigestDescriptor = Object.getOwnPropertyDescriptor(
			crypto.subtle,
			"digest",
		);
		const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
		const allowDuplicateDigest = deferred();
		const duplicateContinued = deferred();
		const firstUploadStarted = deferred();
		const releaseFirstUpload = deferred();
		let digestCalls = 0;
		let uploadCalls = 0;
		Object.defineProperty(crypto.subtle, "digest", {
			configurable: true,
			writable: true,
			value(...args) {
				digestCalls += 1;
				const digest = Promise.resolve(originalDigest(...args));
				if (digestCalls !== 2) return digest;
				const controlled = Promise.all([
					digest,
					allowDuplicateDigest.promise,
				]).then(([value]) => value);
				void controlled.then(() => {
					queueMicrotask(duplicateContinued.resolve);
				});
				return controlled;
			},
		});
		const plan = createAttachmentPlan({
			files: [
				{ b64: "c2FtZSBwYXlsb2Fk", mime: "text/plain", filename: "a.txt" },
				{ b64: "c2FtZSBwYXlsb2Fk", mime: "text/plain", filename: "a.txt" },
			],
		});

		try {
			await withFetch(
				async (url, init = {}) => {
					const href = String(url);
					if (href === "https://gemini.example/app") {
						return new Response('{"qKIAYe":"push-dedupe"}', { status: 200 });
					}
					if (href !== "https://content-push.googleapis.com/upload") {
						throw new Error(`unexpected fetch ${href}`);
					}
					uploadCalls += 1;
					await assertMultipartRequest(init, {
						filename: "a.txt",
						mime: "text/plain",
						bodyText: "same payload",
					});
					firstUploadStarted.resolve();
					await releaseFirstUpload.promise;
					return new Response("/uploaded/plain-a", { status: 200 });
				},
				async () => {
					const operation = resolveAttachments(
						baseUploadConfig({ cookie: "__Secure-1PSID=psid" }),
						plan,
					);
					await firstUploadStarted.promise;
					allowDuplicateDigest.resolve();
					await duplicateContinued.promise;
					releaseFirstUpload.resolve();
					const result = await operation;
					assert.deepEqual(result.fileRefs, [
						{ ref: "/uploaded/plain-a", name: "a.txt" },
						{ ref: "/uploaded/plain-a", name: "a.txt" },
					]);
					assert.equal(result.usage.uploadedFiles, 1);
					assert.equal(result.usage.dedupedFiles, 1);
					assert.equal(result.usage.multipartUploads, 1);
				},
			);
		} finally {
			if (originalDigestDescriptor) {
				Object.defineProperty(
					crypto.subtle,
					"digest",
					originalDigestDescriptor,
				);
			} else {
				delete crypto.subtle.digest;
			}
		}
		assert.equal(uploadCalls, 1);
	});

	test("keeps MIME and filename in observable dedupe identity", async () => {
		const uploadBodies = [];
		const plan = createAttachmentPlan({
			files: [
				{ b64: "c2FtZSBwYXlsb2Fk", mime: "text/plain", filename: "a.txt" },
				{ b64: "c2FtZSBwYXlsb2Fk", mime: "text/csv", filename: "a.txt" },
				{ b64: "c2FtZSBwYXlsb2Fk", mime: "text/plain", filename: "b.txt" },
			],
		});

		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				if (href === "https://gemini.example/app") {
					return new Response('{"qKIAYe":"push-identity"}', { status: 200 });
				}
				if (href !== "https://content-push.googleapis.com/upload") {
					throw new Error(`unexpected fetch ${href}`);
				}
				const text = await multipartRequestText(init);
				uploadBodies.push(text);
				if (text.includes("Content-Type: text/csv")) {
					return new Response("/uploaded/csv-a", { status: 200 });
				}
				if (text.includes('filename="b.txt"')) {
					return new Response("/uploaded/plain-b", { status: 200 });
				}
				return new Response("/uploaded/plain-a", { status: 200 });
			},
			async () => {
				const result = await resolveAttachments(
					baseUploadConfig({ cookie: "__Secure-1PSID=psid" }),
					plan,
				);
				assert.deepEqual(result.fileRefs, [
					{ ref: "/uploaded/plain-a", name: "a.txt" },
					{ ref: "/uploaded/csv-a", name: "a.txt" },
					{ ref: "/uploaded/plain-b", name: "b.txt" },
				]);
				assert.equal(result.usage.uploadedFiles, 3);
				assert.equal(result.usage.dedupedFiles, 0);
				assert.equal(result.usage.multipartUploads, 3);
			},
		);
		assert.equal(uploadBodies.length, 3);
	});

	test("aggregates plan and materialization failures deterministically", async () => {
		const plan = createAttachmentPlan({
			files: [
				{ b64: "A", mime: "text/plain", filename: "invalid.txt" },
				{ b64: "aGVsbG8=", mime: "text/plain", filename: "large.txt" },
				{
					type: "input_file",
					file_url: "https://files.example/remote.bin",
					filename: "remote.bin",
				},
			],
		});

		await withFetch(
			async (url) => {
				throw new Error(`unexpected fetch ${url}`);
			},
			async () => {
				const result = await resolveAttachments(
					baseUploadConfig({ generic_file_upload_max_bytes: 2 }),
					plan,
				);
				assert.equal(result.fileRefs, null);
				assert.match(result.droppedNote, /missing generic file upload data/);
				assert.match(result.droppedNote, /invalid base64 payload/);
				assert.match(result.droppedNote, /file attachment is too large/);
				assert.equal(result.usage.droppedFiles, 3);
				assert.equal(result.usage.uploadedFiles, 0);
			},
		);
	});

	test("degrades invalid multipart refs without auth fallback", async () => {
		const requests = [];
		const plan = createAttachmentPlan({
			files: [{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" }],
		});
		await withFetch(
			async (url, init = {}) => {
				const href = String(url);
				requests.push(href);
				if (href === "https://gemini.example/app") {
					return new Response('{"qKIAYe":"push-invalid-ref"}', { status: 200 });
				}
				if (href === "https://content-push.googleapis.com/upload") {
					await assertMultipartRequest(init, {
						filename: "note.txt",
						mime: "text/plain",
						bodyText: "hello",
					});
					return new Response("not-a-content-push-ref", { status: 200 });
				}
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				const result = await resolveAttachments(
					baseUploadConfig({
						cookie: "__Secure-1PSID=psid; SAPISID=sapi",
						sapisid: "sapi",
					}),
					plan,
				);
				assert.equal(result.fileRefs, null);
				assert.match(result.droppedNote, /attachment upload failed/);
				assert.equal(result.usage.droppedFiles, 1);
			},
		);
		assert.deepEqual(requests, [
			"https://gemini.example/app",
			"https://content-push.googleapis.com/upload",
		]);
	});

	test("logs aggregate usage without attachment payloads or credentials", async () => {
		const logs = [];
		const plan = createAttachmentPlan({
			files: [
				{ b64: "aGVsbG8=", mime: "text/plain", filename: "secret-name.txt" },
				{ b64: "aGVsbG8=", mime: "text/plain", filename: "secret-name.txt" },
			],
		});
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				withFetch(
					async (url) => {
						const href = String(url);
						if (href === "https://gemini.example/app") {
							return new Response('{"qKIAYe":"push-log"}', { status: 200 });
						}
						if (href === "https://content-push.googleapis.com/upload") {
							return new Response("/uploaded/log-ref", { status: 200 });
						}
						throw new Error(`unexpected fetch ${href}`);
					},
					async () => {
						const result = await resolveAttachments(
							baseUploadConfig({
								cookie: "__Secure-1PSID=psid-secret",
								log_requests: true,
							}),
							plan,
						);
						assert.equal(result.usage.uploadedFiles, 1);
						assert.equal(result.usage.dedupedFiles, 1);
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
		assert.doesNotMatch(
			logs.join("\n"),
			/psid-secret|secret-name\.txt|hello|aGVsbG8=/,
		);
	});

	test("records multipart rejection as a dropped request-local attachment", async () => {
		const logs = [];
		const plan = createAttachmentPlan({
			files: [
				{ b64: "aGVsbG8=", mime: "text/plain", filename: "fallback.txt" },
			],
		});
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				withFetch(
					async (url, init = {}) => {
						const href = String(url);
						if (href === "https://gemini.example/app") {
							return new Response('{"qKIAYe":"push-log-failure"}', {
								status: 200,
							});
						}
						if (href === "https://content-push.googleapis.com/upload") {
							await assertMultipartRequest(init, {
								filename: "fallback.txt",
								mime: "text/plain",
								bodyText: "hello",
							});
							return new Response("upstream unavailable", { status: 500 });
						}
						throw new Error(`unexpected fetch ${href}`);
					},
					async () => {
						const result = await resolveAttachments(
							baseUploadConfig({
								cookie: "__Secure-1PSID=psid",
								log_requests: true,
							}),
							plan,
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
