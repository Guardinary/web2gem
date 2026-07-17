import { describe, test } from "vitest";
import { base64ToBytes } from "../../../../src/attachments/base64";
import {
	DEFAULT_GENERATED_IMAGE_HYDRATION_LIMITS,
	generatedImageFetchHeaders,
	generatedImagePreviewFetchUrls,
	hydrateGeneratedImages,
} from "../../../../src/gemini/client/generated-images";
import { assert } from "../../assertions.js";
import { withFetch } from "../../helpers.js";
import { baseGeminiClientConfig } from "../_support/client-fixtures.js";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function generatedImage(url, overrides = {}) {
	return { url, source: "generated", ...overrides };
}

async function withoutTypedArrayEncodingMethods(run) {
	const base64Descriptor = Object.getOwnPropertyDescriptor(
		Uint8Array.prototype,
		"toBase64",
	);
	Object.defineProperty(Uint8Array.prototype, "toBase64", {
		value: undefined,
		configurable: true,
	});
	try {
		return await run();
	} finally {
		if (base64Descriptor)
			Object.defineProperty(Uint8Array.prototype, "toBase64", base64Descriptor);
		else delete Uint8Array.prototype.toBase64;
	}
}

describe("generated image hydration", () => {
	test("preserves generated image preview URL candidates", () => {
		const previewUrl = "https://lh3.googleusercontent.com/generated=s1024-rj";
		assert.deepEqual(generatedImagePreviewFetchUrls(previewUrl), [
			"https://lh3.googleusercontent.com/generated=s2048-rj",
			previewUrl,
		]);
		const directUrl =
			"https://lh3.googleusercontent.com/gg-dl/AFfU-direct-image";
		assert.deepEqual(generatedImagePreviewFetchUrls(directUrl), [
			directUrl,
			`${directUrl}=s2048-rj`,
		]);
		assert.deepEqual(
			generatedImagePreviewFetchUrls(
				"https://lh3.googleusercontent.com/generated=s2048-rj",
			),
			["https://lh3.googleusercontent.com/generated=s2048-rj"],
		);
	});

	test("builds browser image headers without authorization", () => {
		const headers = generatedImageFetchHeaders({
			cookie: "__Secure-1PSID=value",
		});
		assert.equal(
			headers.Accept,
			"image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
		);
		assert.equal(headers["Accept-Language"], "en-US,en;q=0.9");
		assert.equal(headers.Origin, "https://gemini.google.com");
		assert.equal(headers.Referer, "https://gemini.google.com/app");
		assert.match(headers["User-Agent"], /Mozilla\/5\.0/);
		assert.equal(headers.Cookie, "__Secure-1PSID=value");
		assert.equal(headers.Authorization, undefined);
		assert.equal(generatedImageFetchHeaders({ cookie: "" }).Cookie, undefined);
	});

	test("fetches direct gg-dl URLs before their size-suffix fallback", async () => {
		const cfg = baseGeminiClientConfig({ cookie: "SID=base" });
		const activeCfg = baseGeminiClientConfig({ cookie: "SID=selected" });
		const imageUrl =
			"https://lh3.googleusercontent.com/gg-dl/AFfU-direct-image";
		const calls = [];
		let images;
		await withFetch(
			async (url, init) => {
				calls.push(String(url));
				if (String(url) !== imageUrl)
					throw new Error(`unexpected image fetch ${String(url)}`);
				assert.equal(init.headers.Cookie, "SID=selected");
				assert.equal(init.headers.Authorization, undefined);
				return new Response(base64ToBytes(TINY_PNG_BASE64), {
					status: 200,
					headers: { "content-type": "image/png" },
				});
			},
			async () => {
				images = await hydrateGeneratedImages(cfg, activeCfg, [
					generatedImage(imageUrl),
				]);
			},
		);
		assert.deepEqual(calls, [imageUrl]);
		assert.equal(images[0].url, imageUrl);
		assert.equal(images[0].base64, TINY_PNG_BASE64);
		assert.equal(images[0].outputFormat, "png");
	});

	test("cancels an individual image that exceeds its byte limit", async () => {
		assert.deepEqual(DEFAULT_GENERATED_IMAGE_HYDRATION_LIMITS, {
			maxImageBytes: 16 * 1024 * 1024,
			maxTotalBytes: 48 * 1024 * 1024,
		});
		const cfg = baseGeminiClientConfig();
		const tinyPng = base64ToBytes(TINY_PNG_BASE64);
		let canceled = false;
		let calls = 0;
		let images;
		await withFetch(
			async () => {
				calls += 1;
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(tinyPng);
						},
						cancel() {
							canceled = true;
						},
					}),
					{ status: 200 },
				);
			},
			async () => {
				images = await hydrateGeneratedImages(
					cfg,
					cfg,
					[generatedImage("https://images.example/oversized.png")],
					{ maxImageBytes: tinyPng.byteLength - 1, maxTotalBytes: 1000 },
				);
			},
		);
		assert.equal(images[0].base64, undefined);
		assert.equal(canceled, true);
		assert.equal(calls, 1);
	});

	test("stops hydrating after the aggregate image byte budget", async () => {
		const cfg = baseGeminiClientConfig();
		const tinyPng = base64ToBytes(TINY_PNG_BASE64);
		let calls = 0;
		let images;
		await withFetch(
			async () => {
				calls += 1;
				return new Response(tinyPng, { status: 200 });
			},
			async () => {
				images = await hydrateGeneratedImages(
					cfg,
					cfg,
					[
						generatedImage("https://images.example/one.png"),
						generatedImage("https://images.example/two.png"),
					],
					{
						maxImageBytes: tinyPng.byteLength,
						maxTotalBytes: tinyPng.byteLength + 1,
					},
				);
			},
		);
		assert.equal(images[0].base64, TINY_PNG_BASE64);
		assert.equal(images[1].base64, undefined);
		assert.equal(calls, 2);
	});

	test("falls back from s2048 to s1024 and detects jpeg bytes", async () => {
		const cfg = baseGeminiClientConfig();
		const imageUrl = "https://lh3.googleusercontent.com/generated=s1024-rj";
		const calls = [];
		let images;
		await withFetch(
			async (url) => {
				calls.push(String(url));
				if (String(url).endsWith("=s2048-rj"))
					return new Response("preview not ready", { status: 404 });
				if (String(url) === imageUrl)
					return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00]), {
						status: 200,
						headers: { "content-type": "image/jpeg" },
					});
				throw new Error(`unexpected image fetch ${String(url)}`);
			},
			async () => {
				images = await hydrateGeneratedImages(cfg, cfg, [
					generatedImage(imageUrl),
				]);
			},
		);
		assert.deepEqual(calls, [
			"https://lh3.googleusercontent.com/generated=s2048-rj",
			imageUrl,
		]);
		assert.equal(images[0].outputFormat, "jpeg");
	});

	test("detects gif and webp bytes", async () => {
		const cfg = baseGeminiClientConfig();
		const imageCases = [
			{
				url: "https://lh3.googleusercontent.com/generated-gif=s2048-rj",
				bytes: new TextEncoder().encode("GIF89a...."),
				format: "gif",
			},
			{
				url: "https://lh3.googleusercontent.com/generated-webp=s2048-rj",
				bytes: Uint8Array.from([
					0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
					0x50,
				]),
				format: "webp",
			},
		];
		for (const item of imageCases) {
			let images;
			await withFetch(
				async (url) => {
					assert.equal(String(url), item.url);
					return new Response(item.bytes, { status: 200 });
				},
				async () => {
					images = await hydrateGeneratedImages(cfg, cfg, [
						generatedImage(item.url),
					]);
				},
			);
			assert.equal(images[0].outputFormat, item.format);
		}
	});

	test("keeps web images without fetching bytes", async () => {
		const cfg = baseGeminiClientConfig();
		let calls = 0;
		let images;
		await withFetch(
			async () => {
				calls += 1;
				throw new Error("web image URLs must not be hydrated");
			},
			async () => {
				images = await hydrateGeneratedImages(cfg, cfg, [
					{
						url: "https://images.example/web-only.png",
						source: "web",
					},
				]);
			},
		);
		assert.equal(calls, 0);
		assert.equal(images[0].source, "web");
		assert.equal(images[0].base64, undefined);
	});

	test("encodes image bytes without TypedArray base64 helpers", async () => {
		const cfg = baseGeminiClientConfig();
		const imageUrl = "https://lh3.googleusercontent.com/generated.png";
		let images;
		await withoutTypedArrayEncodingMethods(async () => {
			await withFetch(
				async (url) => {
					assert.equal(String(url), imageUrl);
					return new Response(base64ToBytes(TINY_PNG_BASE64), {
						status: 200,
						headers: { "content-type": "image/png" },
					});
				},
				async () => {
					images = await hydrateGeneratedImages(cfg, cfg, [
						generatedImage(imageUrl),
					]);
				},
			);
		});
		assert.equal(images[0].base64, TINY_PNG_BASE64);
		assert.equal(images[0].outputFormat, "png");
	});

	test("rejects non-image bodies even with an image content type", async () => {
		const cfg = baseGeminiClientConfig();
		const imageUrl = "https://lh3.googleusercontent.com/generated.png";
		const calls = [];
		let images;
		await withFetch(
			async (url) => {
				calls.push(String(url));
				return new Response("<html>not an image</html>", {
					status: 200,
					headers: { "content-type": "image/png" },
				});
			},
			async () => {
				images = await hydrateGeneratedImages(cfg, cfg, [
					generatedImage(imageUrl),
				]);
			},
		);
		assert.deepEqual(calls, [imageUrl, `${imageUrl}=s2048-rj`]);
		assert.equal(images[0].url, imageUrl);
		assert.equal(images[0].base64, undefined);
		assert.equal(images[0].outputFormat, undefined);
	});
});
