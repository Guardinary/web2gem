import { assert } from "./assertions.js";
import {
	createMemoryCache,
	fakeSocketConnect,
	mod,
	withCaches,
	withConsoleLog,
	withFetch,
} from "./helpers.js";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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

function wrbLine(texts) {
	const inner = [null, null, null, null, [[null, texts]], "x".repeat(160)];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

function richWrbLine(candidate) {
	const inner = [null, null, null, null, [candidate], "x".repeat(160)];
	return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

function framedWrbRaw(candidate) {
	const inner = [
		null,
		["cid_1", "rid_1", "rcid_meta"],
		null,
		null,
		[candidate],
		"x".repeat(160),
	];
	const payload = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
	const emptyPayload = JSON.stringify([
		[
			"wrb.fr",
			null,
			JSON.stringify([null, null, null, null, [], "x".repeat(160)]),
		],
	]);
	return `)]}'\n\n${payload.length}\n${payload}${emptyPayload.length}\n${emptyPayload}`;
}

function fatalWrbLine(code, location = "inner") {
	const inner = [null, null, null, null, []];
	const envelope = ["wrb.fr", null, JSON.stringify(inner)];
	const target = location === "envelope" ? envelope : inner;
	target[5] = [];
	target[5][2] = [];
	target[5][2][0] = [];
	target[5][2][0][1] = [code];
	if (location !== "envelope") envelope[2] = JSON.stringify(inner);
	return JSON.stringify([envelope]);
}

function generatedImageEntry(
	url = "https://lh3.googleusercontent.com/generated=s1024-rj",
	id = "img_1",
) {
	const meta = [];
	meta[3] = [];
	meta[3][2] = "generated alt";
	meta[3][3] = url;
	return [meta, [id]];
}

function generatedImageCandidate(
	text = "final text",
	url = "https://lh3.googleusercontent.com/generated=s1024-rj",
) {
	const candidate = [];
	candidate[1] = [text];
	candidate[8] = [2];
	candidate[12] = [];
	candidate[12][7] = [[generatedImageEntry(url)]];
	return candidate;
}

function webImageEntry(url = "https://images.example/web.png") {
	const meta = [];
	meta[0] = [url];
	meta[4] = "web alt";
	const entry = [];
	entry[0] = meta;
	entry[7] = ["web title"];
	return entry;
}

function webImageCandidate(
	text = "web result",
	url = "https://images.example/web.png",
) {
	const candidate = [];
	candidate[22] = [text];
	candidate[8] = [2];
	candidate[12] = [];
	candidate[12][1] = [[webImageEntry(url)]];
	return candidate;
}

function baseGeminiClientConfig(overrides = {}) {
	return {
		gemini_origin: "https://gemini.example",
		gemini_bl: "boq_test",
		cookie: "",
		sapisid: "",
		request_timeout_sec: 180,
		retry_attempts: 1,
		retry_delay_sec: 0,
		current_input_file_min_bytes: 1000000,
		upstream_socket: false,
		log_requests: false,
		...overrides,
	};
}

function textResponse(text) {
	return new Response(text);
}

async function assertRejectsWithCode(run, code) {
	try {
		await run();
	} catch (err) {
		assert.equal(err.code, code);
		return;
	}
	throw new Error(`expected rejection with code ${code}`);
}

export const suiteName = "gemini client";
export const cases = [
	[
		"strips generated code artifacts from Gemini text",
		async () => {
			const source = [
				"keep",
				"```python?code_reference&code_event_index=1",
				"drop",
				"```",
				"http://googleusercontent.com/card_content/123",
				"http://googleusercontent.com/image_generation_content/0",
			].join("\n");
			assert.equal(mod.stripArtifacts(source).trim(), "keep");
			assert.equal(mod.cleanText(`  ${source}  `), "keep");
		},
	],
	[
		"extracts longest response text from WRB lines",
		async () => {
			const line = wrbLine(["short", "longer response"]);
			assert.deepEqual(mod.extractTextsFromLine(line), [
				"short",
				"longer response",
			]);
			assert.deepEqual(mod.extractTextsFromLine(` \t${line}`), [
				"short",
				"longer response",
			]);
			assert.deepEqual(
				mod.extractTextsFromLine(
					JSON.stringify([
						[
							"wrb.fr",
							null,
							JSON.stringify([null, null, null, null, [[null, ["tiny"]]]]),
						],
					]),
				),
				["tiny"],
			);
			assert.deepEqual(mod.extractTextsFromLine("not json"), []);
			assert.deepEqual(
				mod.extractTextsFromLine(`${"x".repeat(220)} "wrb.fr"`),
				[],
			);
			assert.deepEqual(
				mod.extractTextsFromLine(JSON.stringify([["wrb.fr", null, "{"]])),
				[],
			);
			assert.match(
				mod.wrbResponseShapeSummary(JSON.stringify([["wrb.fr", null, "{"]])),
				/topIssue=invalid_inner_json:1/,
			);

			const raw = [wrbLine(["first"]), wrbLine(["first plus more"])].join("\n");
			assert.equal(mod.extractResponseText(raw), "first plus more");
			assert.match(mod.wrbResponseShapeSummary(raw), /wrbLines=2/);
			assert.match(mod.wrbResponseShapeSummary(raw), /textParts=2/);
		},
	],
	[
		"extracts rich generated image parts without changing text extraction",
		async () => {
			const raw = richWrbLine(generatedImageCandidate("image ready"));
			const parts = mod.extractResponseParts(raw);
			assert.equal(mod.extractResponseText(raw), "image ready");
			assert.equal(parts.text, "image ready");
			assert.equal(parts.generatedImageCount, 1);
			assert.equal(parts.webImageCount, 0);
			assert.equal(parts.images[0].source, "generated");
			assert.equal(
				parts.images[0].url,
				"https://lh3.googleusercontent.com/generated=s1024-rj",
			);
			assert.equal(parts.images[0].imageId, "img_1");
			assert.match(mod.richResponseShapeSummary(raw), /generatedImages=1/);
		},
	],
	[
		"extracts rich web image metadata and card text",
		async () => {
			const raw = richWrbLine(webImageCandidate("card answer"));
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "card answer");
			assert.equal(parts.generatedImageCount, 0);
			assert.equal(parts.webImageCount, 1);
			assert.equal(parts.images[0].source, "web");
			assert.equal(parts.images[0].url, "https://images.example/web.png");
			assert.equal(parts.images[0].alt, "web alt");
			assert.equal(parts.images[0].title, "web title");
		},
	],
	[
		"strips generated-image placeholder text while keeping rich images",
		async () => {
			const raw = richWrbLine(
				generatedImageCandidate(
					"http://googleusercontent.com/image_generation_content/0",
				),
			);
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "");
			assert.equal(parts.generatedImageCount, 1);
			assert.equal(
				parts.images[0].url,
				"https://lh3.googleusercontent.com/generated=s1024-rj",
			);
		},
	],
	[
		"prefers completed or richer repeated candidate states",
		async () => {
			const incompleteTextOnly = [];
			incompleteTextOnly[1] = ["draft"];

			const completedGenerated = generatedImageCandidate("final");
			const completedFirst = [
				richWrbLine(incompleteTextOnly),
				richWrbLine(completedGenerated),
			].join("\n");
			const completedParts = mod.extractResponseParts(completedFirst);
			assert.equal(completedParts.text, "final");
			assert.equal(completedParts.generatedImageCount, 1);

			const laterIncomplete = generatedImageCandidate(
				"later incomplete with longer text",
			);
			laterIncomplete[8] = [1];
			const keepCompleted = [
				richWrbLine(completedGenerated),
				richWrbLine(laterIncomplete),
			].join("\n");
			const keepCompletedParts = mod.extractResponseParts(keepCompleted);
			assert.equal(keepCompletedParts.text, "final");
			assert.equal(keepCompletedParts.generatedImageCount, 1);

			const richerIncomplete = generatedImageCandidate("richer");
			richerIncomplete[8] = [1];
			const richerParts = mod.extractResponseParts(
				[richWrbLine(incompleteTextOnly), richWrbLine(richerIncomplete)].join(
					"\n",
				),
			);
			assert.equal(richerParts.text, "richer");
			assert.equal(richerParts.generatedImageCount, 1);
		},
	],
	[
		"handles malformed rich envelopes and invalid framed chunks without throwing",
		async () => {
			assert.equal(mod.extractResponseParts(null).text, "");
			assert.equal(
				mod.extractResponseParts(JSON.stringify([["wrb.fr", null, null]]))
					.candidateCount,
				0,
			);
			assert.equal(
				mod.extractResponseParts(JSON.stringify([["wrb.fr", null, "{"]]))
					.candidateCount,
				0,
			);
			assert.equal(
				mod.extractResponseParts(
					JSON.stringify([
						[
							"wrb.fr",
							null,
							JSON.stringify([null, null, null, null, ["not an array"]]),
						],
					]),
				).candidateCount,
				1,
			);
			assert.equal(mod.extractResponseParts(")]}'\n\n0\n[]").candidateCount, 0);
			assert.equal(
				mod.extractResponseParts(")]}'\n\n999\n[]").candidateCount,
				0,
			);
			assert.equal(
				mod.extractResponseParts(")]}'\n\n5\nnot-json").candidateCount,
				0,
			);
			assert.equal(
				mod.extractResponseParts(")]}'\n\n1x\n[]").candidateCount,
				0,
			);
		},
	],
	[
		"extracts image-to-image generated image path and does not merge alternatives",
		async () => {
			const first = [];
			first[1] = ["first candidate"];
			first[8] = [2];
			first[12] = [];
			first[12][0] = {
				8: [
					[
						generatedImageEntry(
							"https://lh3.googleusercontent.com/first=s1024-rj",
							"first-id",
						),
					],
				],
			};

			const second = generatedImageCandidate("second candidate");
			second[12][7] = [
				[
					generatedImageEntry(
						"https://lh3.googleusercontent.com/second=s1024-rj",
						"second-id",
					),
				],
			];

			const inner = [null, null, null, null, [first, second], "x".repeat(160)];
			const raw = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "first candidate");
			assert.equal(parts.generatedImageCount, 1);
			assert.equal(
				parts.images[0].url,
				"https://lh3.googleusercontent.com/first=s1024-rj",
			);
		},
	],
	[
		"does not attach alternative candidate text to selected image-only candidate",
		async () => {
			const imageOnly = generatedImageCandidate("");
			const textOnly = [];
			textOnly[1] = ["alternative candidate text"];
			textOnly[8] = [2];

			const inner = [
				null,
				null,
				null,
				null,
				[imageOnly, textOnly],
				"x".repeat(160),
			];
			const raw = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "");
			assert.equal(parts.generatedImageCount, 1);
			assert.equal(
				parts.images[0].url,
				"https://lh3.googleusercontent.com/generated=s1024-rj",
			);
		},
	],
	[
		"keeps default first-candidate selection even when alternatives contain images",
		async () => {
			const selectedTextOnly = [];
			selectedTextOnly[1] = ["selected text only"];
			selectedTextOnly[8] = [2];

			const alternativeImage = generatedImageCandidate("alternative image");
			alternativeImage[12][7] = [
				[
					generatedImageEntry(
						"https://lh3.googleusercontent.com/alternative=s1024-rj",
						"alt-id",
					),
				],
			];

			const inner = [
				null,
				null,
				null,
				null,
				[selectedTextOnly, alternativeImage],
				"x".repeat(160),
			];
			const raw = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "selected text only");
			assert.equal(parts.generatedImageCount, 0);
			assert.equal(parts.images.length, 0);
		},
	],
	[
		"extracts rich generated images from length-prefixed frames",
		async () => {
			const candidate = generatedImageCandidate("image 🟦 ready");
			candidate[0] = "rcid_1";
			const raw = framedWrbRaw(candidate);
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "image 🟦 ready");
			assert.equal(parts.generatedImageCount, 1);
			assert.equal(
				parts.images[0].url,
				"https://lh3.googleusercontent.com/generated=s1024-rj",
			);
			assert.equal(parts.images[0].cid, "cid_1");
			assert.equal(parts.images[0].rid, "rid_1");
			assert.equal(parts.images[0].rcid, "rcid_1");
		},
	],
	[
		"maps numeric Gemini fatal part codes from inner payloads and envelopes",
		async () => {
			assert.equal(
				mod.extractResponseParts(fatalWrbLine(1013)).fatalCode,
				"1013",
			);
			assert.equal(
				mod.extractResponseParts(fatalWrbLine(1052, "envelope")).fatalCode,
				"1052",
			);
			assert.match(
				mod.richResponseShapeSummary(fatalWrbLine(1060)),
				/fatalCode=1060/,
			);
		},
	],
	[
		"dedupes repeated rich generated image frames",
		async () => {
			const raw = [
				richWrbLine(generatedImageCandidate("progress")),
				richWrbLine(generatedImageCandidate("progress done")),
			].join("\n");
			const parts = mod.extractResponseParts(raw);
			assert.equal(parts.text, "progress done");
			assert.equal(parts.generatedImageCount, 1);
		},
	],
	[
		"preserves generated image URL candidates and browser headers",
		async () => {
			const previewUrl = "https://lh3.googleusercontent.com/generated=s1024-rj";
			assert.deepEqual(mod.generatedImagePreviewFetchUrls(previewUrl), [
				"https://lh3.googleusercontent.com/generated=s2048-rj",
				previewUrl,
			]);
			const directUrl =
				"https://lh3.googleusercontent.com/gg-dl/AFfU-direct-image";
			assert.deepEqual(mod.generatedImagePreviewFetchUrls(directUrl), [
				directUrl,
				`${directUrl}=s2048-rj`,
			]);
			assert.deepEqual(
				mod.generatedImagePreviewFetchUrls(
					"https://lh3.googleusercontent.com/generated=s2048-rj",
				),
				["https://lh3.googleusercontent.com/generated=s2048-rj"],
			);

			const headers = mod.generatedImageFetchHeaders({
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
			assert.equal(
				mod.generatedImageFetchHeaders({ cookie: "" }).Cookie,
				undefined,
			);
		},
	],
	[
		"fetches direct gg-dl generated image URLs before trying size suffix fallback",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const imageUrl =
				"https://lh3.googleusercontent.com/gg-dl/AFfU-direct-image";
			const calls = [];
			await withFetch(
				async (url) => {
					calls.push(String(url));
					if (String(url).includes("StreamGenerate")) {
						return new Response(
							richWrbLine(generatedImageCandidate("", imageUrl)),
							{ status: 200 },
						);
					}
					if (String(url) === imageUrl) {
						return new Response(mod.base64ToBytes(TINY_PNG_BASE64), {
							status: 200,
							headers: { "content-type": "image/png" },
						});
					}
					return new Response("not found", { status: 404 });
				},
				async () => {
					const rich = await mod.generateRich(
						cfg,
						"draw image",
						1,
						4,
						null,
						null,
					);
					assert.equal(rich.text, "");
					assert.equal(rich.images.length, 1);
					assert.equal(rich.images[0].url, imageUrl);
					assert.equal(rich.images[0].base64, TINY_PNG_BASE64);
					assert.equal(rich.images[0].outputFormat, "png");
				},
			);
			assert.match(
				calls[0],
				/^https:\/\/gemini\.example\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate\?/,
			);
			assert.equal(calls[1], imageUrl);
			assert.equal(calls.length, 2);
		},
	],
	[
		"bounds individual and aggregate generated image hydration",
		async () => {
			assert.deepEqual(mod.DEFAULT_GENERATED_IMAGE_HYDRATION_LIMITS, {
				maxImageBytes: 16 * 1024 * 1024,
				maxTotalBytes: 48 * 1024 * 1024,
			});
			const cfg = baseGeminiClientConfig();
			const tinyPng = mod.base64ToBytes(TINY_PNG_BASE64);
			let canceled = false;
			let calls = 0;
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
					const oversized = await mod.hydrateGeneratedImages(
						cfg,
						cfg,
						[
							{
								url: "https://images.example/oversized.png",
								source: "generated",
							},
						],
						{ maxImageBytes: tinyPng.byteLength - 1, maxTotalBytes: 1000 },
					);
					assert.equal(oversized[0].base64, undefined);
				},
			);
			assert.equal(calls, 1);
			assert.equal(canceled, true);

			calls = 0;
			await withFetch(
				async () => {
					calls += 1;
					return new Response(tinyPng, { status: 200 });
				},
				async () => {
					const images = await mod.hydrateGeneratedImages(
						cfg,
						cfg,
						[
							{ url: "https://images.example/one.png", source: "generated" },
							{ url: "https://images.example/two.png", source: "generated" },
						],
						{
							maxImageBytes: tinyPng.byteLength,
							maxTotalBytes: tinyPng.byteLength + 1,
						},
					);
					assert.equal(images[0].base64, TINY_PNG_BASE64);
					assert.equal(images[1].base64, undefined);
				},
			);
			assert.equal(calls, 2);
		},
	],
	[
		"fetches s1024 generated image fallback URLs and detects jpeg bytes",
		async () => {
			const cfg = baseGeminiClientConfig();
			const imageUrl = "https://lh3.googleusercontent.com/generated=s1024-rj";
			const calls = [];
			await withFetch(
				async (url) => {
					calls.push(String(url));
					if (String(url).includes("StreamGenerate")) {
						return new Response(
							richWrbLine(generatedImageCandidate("", imageUrl)),
							{ status: 200 },
						);
					}
					if (String(url).endsWith("=s2048-rj")) {
						return new Response("preview not ready", { status: 404 });
					}
					if (String(url) === imageUrl) {
						return new Response(
							Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00]),
							{ status: 200, headers: { "content-type": "image/jpeg" } },
						);
					}
					return new Response("not found", { status: 404 });
				},
				async () => {
					const rich = await mod.generateRich(
						cfg,
						"draw image",
						1,
						4,
						null,
						null,
					);
					assert.equal(rich.images.length, 1);
					assert.equal(rich.images[0].outputFormat, "jpeg");
				},
			);
			assert.equal(
				calls[1],
				"https://lh3.googleusercontent.com/generated=s2048-rj",
			);
			assert.equal(calls[2], imageUrl);
		},
	],
	[
		"detects gif and webp generated image bytes",
		async () => {
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
				await withFetch(
					async (url) => {
						if (String(url).includes("StreamGenerate")) {
							return new Response(
								richWrbLine(generatedImageCandidate("", item.url)),
								{ status: 200 },
							);
						}
						if (String(url) === item.url) {
							return new Response(item.bytes, { status: 200 });
						}
						return new Response("not found", { status: 404 });
					},
					async () => {
						const rich = await mod.generateRich(
							cfg,
							`draw ${item.format}`,
							1,
							4,
							null,
							null,
						);
						assert.equal(rich.images.length, 1);
						assert.equal(rich.images[0].outputFormat, item.format);
					},
				);
			}
		},
	],
	[
		"keeps web-only rich images without fetching image bytes",
		async () => {
			const cfg = baseGeminiClientConfig();
			const calls = [];
			await withFetch(
				async (url) => {
					calls.push(String(url));
					if (String(url).includes("StreamGenerate")) {
						return new Response(
							richWrbLine(
								webImageCandidate("", "https://images.example/web-only.png"),
							),
							{ status: 200 },
						);
					}
					throw new Error(
						"web image URLs should not be fetched by generateRich",
					);
				},
				async () => {
					const rich = await mod.generateRich(
						cfg,
						"show web image",
						1,
						4,
						null,
						null,
					);
					assert.equal(rich.images.length, 1);
					assert.equal(rich.images[0].source, "web");
					assert.equal(
						rich.images[0].url,
						"https://images.example/web-only.png",
					);
					assert.equal(rich.images[0].base64, undefined);
				},
			);
			assert.equal(calls.length, 1);
		},
	],
	[
		"maps rich fatal and empty upstream responses to image-specific errors",
		async () => {
			const cfg = baseGeminiClientConfig();
			await withFetch(
				async () => new Response(fatalWrbLine(1013), { status: 200 }),
				async () => {
					await assertRejectsWithCode(
						() => mod.generateRich(cfg, "draw image", 1, 4, null, null),
						"upstream_image_provider_error",
					);
				},
			);

			await withFetch(
				async (url) => {
					if (String(url).includes("/app"))
						return new Response("no fresh build label");
					return new Response(
						JSON.stringify([
							[
								"wrb.fr",
								null,
								JSON.stringify([null, null, null, null, [], "x".repeat(160)]),
							],
						]),
						{ status: 200 },
					);
				},
				async () => {
					await assertRejectsWithCode(
						() => mod.generateRich(cfg, "draw image", 1, 4, null, null),
						"upstream_image_generation_empty",
					);
				},
			);
		},
	],
	[
		"encodes fetched generated image bytes without TypedArray base64 helpers",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const imageUrl = "https://lh3.googleusercontent.com/generated.png";
			await withoutTypedArrayEncodingMethods(async () => {
				await withFetch(
					async (url) => {
						if (String(url).includes("StreamGenerate")) {
							return new Response(
								richWrbLine(generatedImageCandidate("", imageUrl)),
								{ status: 200 },
							);
						}
						if (String(url) === imageUrl) {
							return new Response(mod.base64ToBytes(TINY_PNG_BASE64), {
								status: 200,
								headers: { "content-type": "image/png" },
							});
						}
						return new Response("not found", { status: 404 });
					},
					async () => {
						const rich = await mod.generateRich(
							cfg,
							"draw image",
							1,
							4,
							null,
							null,
						);
						assert.equal(rich.images.length, 1);
						assert.equal(rich.images[0].base64, TINY_PNG_BASE64);
						assert.equal(rich.images[0].outputFormat, "png");
					},
				);
			});
		},
	],
	[
		"rejects non-image generated image bodies even with image content-type",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const imageUrl = "https://lh3.googleusercontent.com/generated.png";
			await withFetch(
				async (url) => {
					if (String(url).includes("StreamGenerate")) {
						return new Response(
							richWrbLine(generatedImageCandidate("", imageUrl)),
							{ status: 200 },
						);
					}
					if (String(url) === imageUrl) {
						return new Response("<html>not an image</html>", {
							status: 200,
							headers: { "content-type": "image/png" },
						});
					}
					return new Response("not found", { status: 404 });
				},
				async () => {
					const rich = await mod.generateRich(
						cfg,
						"draw image",
						1,
						4,
						null,
						null,
					);
					assert.equal(rich.images.length, 1);
					assert.equal(rich.images[0].url, imageUrl);
					assert.equal(rich.images[0].base64, undefined);
					assert.equal(rich.images[0].outputFormat, undefined);
				},
			);
		},
	],
	[
		"keeps StreamGenerate on socket while generated image bytes use fetch",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: true,
				log_requests: false,
			};
			const imageUrl =
				"https://lh3.googleusercontent.com/gg-dl/AFfU-direct-image";
			const raw = richWrbLine(generatedImageCandidate("", imageUrl));
			const socketState = {};
			const socketResponse = `HTTP/1.1 200 OK\r\nContent-Length: ${new TextEncoder().encode(raw).byteLength}\r\n\r\n${raw}`;
			mod._setConnectForTest(fakeSocketConnect([socketResponse], socketState));
			const fetchCalls = [];
			try {
				await withFetch(
					async (url) => {
						fetchCalls.push(String(url));
						if (String(url) === imageUrl) {
							return new Response(mod.base64ToBytes(TINY_PNG_BASE64), {
								status: 200,
								headers: { "content-type": "image/png" },
							});
						}
						return new Response("not found", { status: 404 });
					},
					async () => {
						const rich = await mod.generateRich(
							cfg,
							"draw image",
							1,
							4,
							null,
							null,
						);
						assert.equal(rich.images.length, 1);
						assert.equal(rich.images[0].base64, TINY_PNG_BASE64);
					},
				);
			} finally {
				mod._setConnectForTest(null);
			}
			const socketRequestText = socketState.writes
				.map((chunk) => new TextDecoder().decode(chunk))
				.join("");
			assert.match(socketRequestText, /StreamGenerate/);
			assert.doesNotMatch(socketRequestText, /gg-dl/);
			assert.equal(fetchCalls.includes(imageUrl), true);
		},
	],
	[
		"summarizes WRB parse issue branches without throwing",
		async () => {
			const parseIssueInputs = [
				JSON.stringify({ not: "an array" }),
				JSON.stringify([["wrb.fr", null, null]]),
				JSON.stringify([["wrb.fr", null, JSON.stringify([null])]]),
				JSON.stringify([
					[
						"wrb.fr",
						null,
						JSON.stringify([null, null, null, null, "not parts"]),
					],
				]),
				JSON.stringify([
					[
						"wrb.fr",
						null,
						JSON.stringify([null, null, null, null, [[null, []]]]),
					],
				]),
			];
			const summary = mod.wrbResponseShapeSummary(parseIssueInputs.join("\n"));
			assert.match(summary, /wrbLines=4/);
			assert.match(summary, /parsedEnvelopes=4/);
			assert.match(summary, /parsedInnerPayloads=3/);
			assert.deepEqual(
				parseIssueInputs.map((item) => mod.extractTextsFromLine(item)),
				[[], [], [], [], []],
			);
		},
	],
	[
		"bounds app page marker scanning for unterminated quoted values",
		async () => {
			const oversized = `"qKIAYe":"${"x".repeat(10 * 1024)}`;
			assert.deepEqual(
				await mod.extractGeminiAppPageTokens(textResponse(oversized)),
				{},
			);
			assert.equal(await mod.extractGeminiPushId(textResponse(oversized)), "");

			const buildLabel = "boq_assistant-bard-web-server_20260709.09_p0";
			assert.equal(
				await mod.extractGeminiBuildLabel(
					textResponse(`${oversized}\n${buildLabel}`),
				),
				buildLabel,
			);
		},
	],
	[
		"streams only new text deltas from repeated WRB lines",
		async () => {
			const extractor = mod.createStreamTextExtractor();
			assert.deepEqual(
				[...extractor.consumeLine(wrbLine([" hello"]))],
				["hello"],
			);
			assert.deepEqual(
				[...extractor.consumeLine(wrbLine([" hello world"]))],
				[" world"],
			);
			assert.deepEqual(
				[...extractor.consumeLine(wrbLine([" hello world"]))],
				[],
			);
		},
	],
	[
		"streams long cumulative WRB text without losing append state",
		async () => {
			const extractor = mod.createStreamTextExtractor();
			let cumulative = "";
			let emitted = "";
			for (let i = 0; i < 512; i++) {
				cumulative += `${String(i).padStart(4, "0")}:${"x".repeat(123)}\n`;
				emitted += [...extractor.consumeLine(wrbLine([cumulative]))].join("");
			}
			assert.equal(emitted, cumulative.trimStart());
			assert.deepEqual(
				[...extractor.consumeLine(wrbLine([cumulative.slice(0, -256)]))],
				[],
			);
			assert.deepEqual(
				[...extractor.consumeLine(wrbLine([`${cumulative}tail`]))],
				["tail"],
			);
		},
	],
	[
		"streams visible deltas after artifact-bearing cumulative chunks",
		async () => {
			const extractor = mod.createStreamTextExtractor();
			const artifact = [
				"answer",
				"```python?code_reference&code_event_index=1",
				"print('hidden')",
				"```",
			].join("\n");
			assert.equal(
				[...extractor.consumeLine(wrbLine([artifact]))].join(""),
				"answer\n",
			);
			assert.deepEqual(
				[...extractor.consumeLine(wrbLine([`${artifact}\nmore visible`]))],
				["more visible"],
			);
		},
	],
	[
		"builds Gemini payload with file refs and extra fields",
		async () => {
			const payload = mod.buildPayload(
				"prompt",
				123,
				2,
				[{ ref: "file-ref", name: "doc.txt" }],
				{ 31: 2, 80: 3 },
				"req-test",
			);
			const outer = JSON.parse(new URLSearchParams(payload).get("f.req"));
			const inner = JSON.parse(outer[1]);
			assert.equal(inner.length, 102);
			assert.equal(inner[0][0], "prompt");
			assert.equal(inner[0][3][0][0][0], "file-ref");
			assert.equal(inner[0][3][0][1], "doc.txt");
			assert.equal(inner[3], null);
			assert.equal(inner[31], 2);
			assert.equal(inner[59], "REQ-TEST");
			assert.equal(inner[79], 123);
			assert.equal(inner[80], 3);
			await assert.rejects(
				() => mod.buildPayload("prompt", 123, 2, null, { 79: 999 }),
				/Unsupported Gemini model extra payload field/,
			);
		},
	],
	[
		"builds Gemini request URL and browser headers",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example/",
				gemini_bl: "boq test",
				cookie: "SID=ok",
			};
			const url = mod.getUrl(cfg);
			assert.match(
				url,
				/^https:\/\/gemini\.example\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate\?/,
			);
			assert.match(url, /bl=boq%20test/);

			const headers = await mod.buildHeaders(
				cfg,
				{
					"x-goog-ext-525001261-jspb":
						'[1,null,null,null,"model-id",null,null,0,[4],null,null,1]',
				},
				"request-id",
			);
			assert.equal(headers.Cookie, "SID=ok");
			assert.equal(headers.Origin, "https://gemini.google.com");
			assert.equal(headers["X-Same-Domain"], "1");
			assert.equal(
				headers["x-goog-ext-525001261-jspb"],
				'[1,null,null,null,"model-id",null,null,0,[4],null,null,1]',
			);
			assert.equal(headers["x-goog-ext-525005358-jspb"], '["REQUEST-ID",1]');
			assert.equal(headers.Authorization, undefined);
		},
	],
	[
		"parses and merges cookie headers with quoted values",
		async () => {
			const parsed = Object.fromEntries(
				mod.parseCookieHeader("SID=ok; SAPISID=sapi; __Secure-1PSID=psid"),
			);
			assert.deepEqual(parsed, {
				SID: "ok",
				SAPISID: "sapi",
				"__Secure-1PSID": "psid",
			});

			const split = mod.splitSetCookieHeader(
				[
					"__Secure-1PSIDTS=new; Path=/; Secure",
					"NID=x; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
				].join(", "),
			);
			assert.equal(split.length, 2);

			const merged = mod.mergeSetCookieHeaders(
				"__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				split,
			);
			assert.equal(
				merged,
				"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi; NID=x",
			);

			const quoted = mod.splitSetCookieHeader(
				[
					'A="x,y"; Path=/',
					"B=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
					"C=3; Path=/",
				].join(", "),
			);
			assert.deepEqual(quoted, [
				'A="x,y"; Path=/',
				"B=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
				"C=3; Path=/",
			]);
		},
	],
	[
		"derives active Gemini cookie config without mutating input",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				sapisid: "",
			};
			const active = mod.configWithActiveGeminiCookie(cfg);
			assert.equal(
				active.cookie,
				"__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
			);
			assert.equal(active.sapisid, "sapi");
			assert.equal(cfg.sapisid, "");
		},
	],
	[
		"rotates Gemini cookie with safe RotateCookies headers",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			let calls = 0;
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url, init) => {
					calls += 1;
					assert.equal(
						String(url),
						"https://accounts.google.com/RotateCookies",
					);
					assert.equal(init.method, "POST");
					assert.equal(init.headers.Cookie, cfg.cookie);
					assert.equal(init.headers.Origin, "https://accounts.google.com");
					assert.equal(init.headers.Referer, "https://accounts.google.com/");
					assert.equal(init.headers["Accept-Language"], "en-US,en;q=0.9");
					assert.match(init.headers["User-Agent"], /Mozilla\/5\.0/);
					return new Response("", {
						status: 200,
						headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
					});
				},
				async () => {
					const rotated = await mod.rotateGeminiCookieForRetry(cfg);
					assert.equal(calls, 1);
					assert.equal(
						rotated.cookie,
						"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
					);
					assert.equal(rotated.sapisid, "sapi");
				},
			);
		},
	],
	[
		"debounces failed cookie rotation after upstream rejection",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => new Response("", { status: 401 }),
				async () => {
					assert.equal(await mod.rotateGeminiCookieForRetry(cfg), null);
					const rotated = await mod.rotateGeminiCookieForRetryWithReason(cfg);
					assert.equal(rotated.config, null);
					assert.equal(rotated.reason, "recent_rotation");
				},
			);
		},
	],
	[
		"rejects cookie rotation when no updated cookie returns",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => new Response("", { status: 200 }),
				async () => {
					assert.equal(await mod.rotateGeminiCookieForRetry(cfg), null);
				},
			);
		},
	],
	[
		"coalesces concurrent cookie rotation requests",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			let calls = 0;
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => {
					calls += 1;
					await gate;
					return new Response("", {
						status: 200,
						headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
					});
				},
				async () => {
					const first = mod.rotateGeminiCookieForRetry(cfg);
					const second = mod.rotateGeminiCookieForRetry(cfg);
					release();
					const results = await Promise.all([first, second]);
					assert.equal(calls, 1);
					assert.equal(
						results[0].cookie,
						"__Secure-1PSID=psid; __Secure-1PSIDTS=new",
					);
					assert.equal(
						results[1].cookie,
						"__Secure-1PSID=psid; __Secure-1PSIDTS=new",
					);
				},
			);
		},
	],
	[
		"honors retry attempt limits",
		async () => {
			const cfg = { retry_attempts: 2, retry_delay_sec: 0, log_requests: true };
			const err = new Error("boom secret");
			err.code = "retry_test";
			err.status = 502;
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					assert.equal(await mod.waitBeforeRetry(cfg, 0, err, "Retry"), true);
					assert.equal(await mod.waitBeforeRetry(cfg, 1, err, "Retry"), false);
				},
			);
			assert.deepEqual(logs, [
				"[web2gem] Retry 1/2 type=Error code=retry_test status=502",
			]);
			assert.doesNotMatch(logs[0], /boom secret/);
		},
	],
	[
		"keeps bounded account-scoped metadata hot across alternating accounts",
		async () => {
			const cache = createMemoryCache();
			const metadata = mod.createOriginScopedStringCache({
				cachePrefix: "https://internal-cache/test-metadata/",
				ttlSec: 60,
				payloadKey: "value",
				logLabel: "test metadata",
				accountScoped: true,
				l1MaxEntries: 2,
			});
			const account = (accountId) => ({
				gemini_origin: "https://gemini.example",
				gemini_account: { accountId, cookieHash: `${accountId}-hash` },
				log_requests: false,
			});

			await withCaches(cache, async () => {
				await metadata.setCached(account("a"), "value-a");
				await metadata.setCached(account("b"), "value-b");
				assert.equal(await metadata.getCached(account("a")), "value-a");
				assert.equal(await metadata.getCached(account("b")), "value-b");
				assert.equal(cache.stats.match, 0);

				await metadata.setCached(account("c"), "value-c");
				assert.equal(await metadata.getCached(account("a")), "value-a");
				assert.equal(cache.stats.match, 1);
				assert.equal(await metadata.getCached(account("c")), "value-c");
				assert.equal(cache.stats.match, 1);
			});
		},
	],
	[
		"caches Gemini build labels in the Workers cache API",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "configured-bl",
				log_requests: false,
			};
			const cache = createMemoryCache();
			await withCaches(cache, async () => {
				assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "");
				await mod.setCachedGeminiBuildLabel(cfg, "cached-bl");
				assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "cached-bl");
				assert.equal(cache.stats.match, 1);

				const active = await mod.configWithCachedGeminiBuildLabel(cfg);
				assert.equal(active.gemini_bl, "cached-bl");
				assert.equal(cfg.gemini_bl, "configured-bl");
				assert.equal(cache.stats.match, 1);
			});
		},
	],
	[
		"persists Gemini build labels with waitUntil when available",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "configured-bl",
				log_requests: false,
			};
			const cache = createMemoryCache();
			const pending = [];
			await withCaches(cache, async () => {
				await mod.setCachedGeminiBuildLabel(
					{
						...cfg,
						execution_ctx: {
							waitUntil(promise) {
								pending.push(promise);
							},
						},
					},
					"waituntil-bl",
				);
				assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "waituntil-bl");
				assert.equal(cache.stats.match, 0);
				assert.equal(pending.length, 1);
				await Promise.all(pending);
				assert.equal(cache.stats.put, 1);
			});
		},
	],
	[
		"drops stale cached Gemini build labels",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "configured-bl",
				log_requests: false,
			};
			const cache = createMemoryCache();
			await cache.put(
				new Request(
					`https://internal-cache/gemini-bl/${encodeURIComponent("https://gemini.example")}`,
				),
				new Response(
					JSON.stringify({
						gemini_bl: "stale-bl",
						created_at_ms: Date.now() - 13 * 60 * 60 * 1000,
					}),
				),
			);
			await withCaches(cache, async () => {
				assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "");
				assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "");
			});
		},
	],
	[
		"refreshes Gemini build labels once for concurrent callers",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				cookie: "SID=ok",
				upstream_socket: false,
				log_requests: false,
			};
			const cache = createMemoryCache();
			let calls = 0;
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			await withCaches(cache, async () => {
				await withFetch(
					async (url, init) => {
						calls += 1;
						assert.equal(String(url), "https://gemini.example/app");
						assert.equal(init.headers.Cookie, "SID=ok");
						await gate;
						return new Response('<script>{"cfb2h":"fresh-bl"}</script>', {
							status: 200,
						});
					},
					async () => {
						const first = mod.getFreshGeminiBuildLabel(cfg);
						const second = mod.getFreshGeminiBuildLabel(cfg);
						release();
						assert.deepEqual(await Promise.all([first, second]), [
							"fresh-bl",
							"fresh-bl",
						]);
						assert.equal(calls, 1);
						assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "fresh-bl");
					},
				);
			});
		},
	],
	[
		"reports rejected cookie rotation reason and upstream status",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const cfg = {
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => new Response("", { status: 403 }),
				async () => {
					const rotated = await mod.rotateGeminiCookieForRetryWithReason(cfg);
					assert.equal(rotated.config, null);
					assert.equal(rotated.reason, "rotation_rejected");
					assert.equal(rotated.upstreamStatus, 403);
				},
			);
		},
	],
	[
		"redacts cookies from invalid cookie diagnostics",
		async () => {
			const err = mod.invalidGeminiCookieError(
				{ cookie: "SID=bad" },
				403,
				null,
				"rotation_no_update",
			);
			assert.equal(err.code, "invalid_gemini_cookie");
			assert.equal(
				err.reason,
				"RotateCookies completed but did not return an updated cookie",
			);
			assert.match(
				err.message,
				/Diagnostic: RotateCookies completed but did not return an updated cookie\./,
			);
			assert.doesNotMatch(err.message, /SID=bad/);
		},
	],
	[
		"invalidates page token cache after cookie rotation",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			const cfg = {
				gemini_origin: "https://gemini.example",
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				sapisid: "",
				request_timeout_sec: 180,
				upstream_socket: false,
				log_requests: false,
			};
			const pageCookies = [];
			let appCalls = 0;
			await withFetch(
				async (url, init) => {
					const href = String(url);
					if (href === "https://gemini.example/app") {
						appCalls += 1;
						pageCookies.push(init.headers.Cookie);
						return new Response(`{"SNlM0e":"at-${appCalls}"}`, { status: 200 });
					}
					if (href === "https://accounts.google.com/RotateCookies") {
						return new Response("", {
							status: 200,
							headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
						});
					}
					throw new Error(`unexpected fetch ${href}`);
				},
				async () => {
					const first = await mod.getPageTokens(cfg);
					assert.equal(first.at, "at-1");
					const rotated = await mod.rotateGeminiCookieForRetry(cfg);
					assert.equal(
						rotated.cookie,
						"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
					);
					const second = await mod.getPageTokens(cfg);
					assert.equal(second.at, "at-2");
					assert.deepEqual(pageCookies, [
						"__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
						"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
					]);
					assert.equal(appCalls, 2);
				},
			);
		},
	],
	[
		"deduplicates repeated active cookie names",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			const active = mod.configWithActiveGeminiCookie({
				cookie:
					"__Secure-1PSID=psid; __Secure-1PSIDTS=old; __Secure-1PSIDTS=new; SAPISID=sapi",
				sapisid: "",
			});
			assert.equal(
				active.cookie,
				"__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
			);
		},
	],
	[
		"generates text with page auth token appended for cookie requests",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			const calls = [];
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "__Secure-1PSID=psid; SAPISID=sapi",
				sapisid: "sapi",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url, init = {}) => {
					calls.push({ url: String(url), init });
					if (String(url) === "https://gemini.example/app") {
						return new Response('{"SNlM0e":"at-test"}', { status: 200 });
					}
					assert.match(String(url), /StreamGenerate/);
					assert.match(String(init.body), /&at=at-test/);
					return new Response(
						[
							JSON.stringify([
								[
									"wrb.fr",
									null,
									JSON.stringify([
										null,
										null,
										null,
										null,
										[[null, ["hello"]]],
										"x".repeat(160),
									]),
								],
							]),
						].join("\n"),
						{ status: 200 },
					);
				},
				async () => {
					const text = await mod.generate(cfg, "prompt", 1, 4, null, null);
					assert.equal(text, "hello");
				},
			);
			assert.equal(calls.length, 2);
			assert.equal(calls[0].init.headers.Cookie, cfg.cookie);
		},
	],
	[
		"rejects cookie requests when Gemini page auth token is missing",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			const calls = [];
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "SID=ok",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url) => {
					calls.push(String(url));
					if (String(url) === "https://gemini.example/app")
						return new Response("<html>no at token</html>", { status: 200 });
					throw new Error(`unexpected fetch ${url}`);
				},
				async () => {
					try {
						await mod.generate(cfg, "prompt", 1, 4, null, null);
						throw new Error("expected missing page token failure");
					} catch (err) {
						assert.equal(err.code, "invalid_gemini_cookie");
						assert.match(err.message, /Gemini account pool/);
					}
				},
			);
			assert.deepEqual(calls, ["https://gemini.example/app"]);
		},
	],
	[
		"reports cookie rotation failure when StreamGenerate rejects the cookie",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			const calls = [];
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "__Secure-1PSID=psid; SAPISID=sapi",
				sapisid: "sapi",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url) => {
					const href = String(url);
					calls.push(href);
					if (href === "https://gemini.example/app")
						return new Response('{"SNlM0e":"at-test"}', { status: 200 });
					if (href === "https://accounts.google.com/RotateCookies")
						return new Response("", { status: 200 });
					assert.match(href, /StreamGenerate/);
					return new Response("rejected", { status: 401 });
				},
				async () => {
					try {
						await mod.generate(cfg, "prompt", 1, 4, null, null);
						throw new Error("expected invalid cookie failure");
					} catch (err) {
						assert.equal(err.code, "invalid_gemini_cookie");
						assert.equal(
							err.reason,
							"RotateCookies completed but did not return an updated cookie",
						);
						assert.equal(err.upstreamStatus, 401);
					}
				},
			);
			assert.equal(
				calls.some(
					(href) => href === "https://accounts.google.com/RotateCookies",
				),
				true,
			);
		},
	],
	[
		"retries generate after successful cookie rotation",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			const calls = [];
			let appCalls = 0;
			let streamCalls = 0;
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 2,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url, init = {}) => {
					const href = String(url);
					calls.push({
						href,
						cookie: init.headers?.Cookie,
						body: String(init.body || ""),
					});
					if (href === "https://gemini.example/app") {
						appCalls += 1;
						return new Response(`{"SNlM0e":"at-${appCalls}"}`, { status: 200 });
					}
					if (href === "https://accounts.google.com/RotateCookies") {
						assert.match(init.headers.Cookie, /__Secure-1PSIDTS=old/);
						return new Response("", {
							status: 200,
							headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
						});
					}
					assert.match(href, /StreamGenerate/);
					streamCalls += 1;
					if (streamCalls === 1)
						return new Response("cookie rejected", { status: 401 });
					assert.match(init.headers.Cookie, /__Secure-1PSIDTS=new/);
					assert.match(String(init.body), /&at=at-2/);
					return new Response(wrbLine(["after cookie rotation"]), {
						status: 200,
					});
				},
				async () => {
					const text = await mod.generate(cfg, "prompt", 1, 4, null, null);
					assert.equal(text, "after cookie rotation");
				},
			);
			assert.equal(streamCalls, 2);
			assert.equal(
				calls.some(
					(call) => call.href === "https://accounts.google.com/RotateCookies",
				),
				true,
			);
		},
	],
	[
		"refreshes Gemini build label and retries empty non-stream responses",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "old-bl",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 2,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const streamUrls = [];
			await withFetch(
				async (url) => {
					const href = String(url);
					if (href === "https://gemini.example/app") {
						return new Response('<html>{"cfb2h":"fresh-bl"}</html>', {
							status: 200,
						});
					}
					streamUrls.push(href);
					if (streamUrls.length === 1)
						return new Response("no parseable text", { status: 200 });
					return new Response(wrbLine(["after refresh"]), { status: 200 });
				},
				async () => {
					const text = await mod.generate(cfg, "prompt", 1, 4, null, null);
					assert.equal(text, "after refresh");
				},
			);
			assert.match(streamUrls[0], /bl=old-bl/);
			assert.match(streamUrls[1], /bl=fresh-bl/);
		},
	],
	[
		"throws explicit non-stream upstream error when refresh cannot recover",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "stale-bl",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const calls = [];
			await withFetch(
				async (url) => {
					const href = String(url);
					calls.push(href);
					if (href === "https://gemini.example/app")
						return new Response("<html>no fresh build label</html>", {
							status: 200,
						});
					return new Response("upstream failure without wrb text", {
						status: 502,
					});
				},
				async () => {
					try {
						await mod.generate(cfg, "prompt", 1, 4, null, null);
						throw new Error("expected non-stream upstream failure");
					} catch (err) {
						assert.match(err.message, /HTTP 502 returned no parseable text/);
					}
				},
			);
			assert.equal(
				calls.some((href) => href === "https://gemini.example/app"),
				true,
			);
		},
	],
	[
		"throws explicit non-stream upstream empty error for HTTP 200 responses",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "stale-bl",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url) => {
					if (String(url) === "https://gemini.example/app")
						return new Response("<html>no fresh build label</html>", {
							status: 200,
						});
					return new Response("upstream completed without wrb text", {
						status: 200,
					});
				},
				async () => {
					try {
						await mod.generate(cfg, "prompt", 1, 4, null, null);
						throw new Error("expected upstream empty response");
					} catch (err) {
						assert.equal(err.code, "upstream_empty_response");
						assert.equal(err.status, 502);
						assert.equal(err.upstreamStatus, 200);
						assert.equal(
							err.rawLength,
							"upstream completed without wrb text".length,
						);
					}
				},
			);
		},
	],
	[
		"classifies data-analysis empty responses for uploaded files",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () =>
					new Response("data_analysis_tool returned no final text", {
						status: 200,
					}),
				async () => {
					try {
						await mod.generate(cfg, "prompt", 1, 4, null, [
							{ ref: "file-ref", name: "data.csv" },
						]);
						throw new Error("expected data-analysis empty response");
					} catch (err) {
						assert.equal(err.code, "data_analysis_empty_response");
						assert.match(err.message, /data_analysis_tool/);
					}
				},
			);
		},
	],
	[
		"classifies large prompt empty responses before generic retry exhaustion",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 10,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => new Response("no parseable text", { status: 200 }),
				async () => {
					try {
						await mod.generate(cfg, "x".repeat(20), 1, 4, null, null);
						throw new Error("expected large prompt empty response");
					} catch (err) {
						assert.equal(err.code, "large_prompt_empty_response");
						assert.equal(err.thresholdBytes, 10);
						assert.equal(err.promptBytes > err.thresholdBytes, true);
					}
				},
			);
		},
	],
	[
		"aborts Gemini streams before starting upstream fetch",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const ac = new AbortController();
			ac.abort("stop now");
			await withFetch(
				async () => {
					throw new Error("fetch should not run");
				},
				async () => {
					try {
						for await (const _delta of mod.generateStream(
							cfg,
							"prompt",
							1,
							4,
							null,
							null,
							{ signal: ac.signal },
						)) {
							throw new Error("stream should not yield");
						}
						throw new Error("expected abort");
					} catch (err) {
						assert.equal(err.name, "AbortError");
						assert.equal(err.code, "request_aborted");
						assert.match(err.message, /stop now/);
					}
				},
			);
		},
	],
	[
		"throws for stream responses with no body and no parseable fallback text",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => new Response(null, { status: 502 }),
				async () => {
					try {
						for await (const _delta of mod.generateStream(
							cfg,
							"prompt",
							1,
							4,
							null,
							null,
						)) {
							throw new Error("stream should not yield");
						}
						throw new Error("expected empty stream error");
					} catch (err) {
						assert.equal(err.code, "upstream_empty_response");
						assert.equal(err.status, 502);
						assert.equal(err.upstreamStatus, 502);
						assert.equal(err.rawLength, 0);
					}
				},
			);
		},
	],
	[
		"streams fallback text when Gemini response has no body",
		async () => {
			mod.resetActiveGeminiCookieForTest();
			mod.resetGeminiUploadCachesForTest();
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () =>
					new Response(
						JSON.stringify([
							[
								"wrb.fr",
								null,
								JSON.stringify([
									null,
									null,
									null,
									null,
									[[null, ["stream fallback"]]],
									"x".repeat(160),
								]),
							],
						]),
						{ status: 200 },
					),
				async () => {
					const chunks = [];
					for await (const delta of mod.generateStream(
						cfg,
						"prompt",
						1,
						4,
						null,
						null,
					))
						chunks.push(delta);
					assert.deepEqual(chunks, ["stream fallback"]);
				},
			);
		},
	],
	[
		"streams fallback text from response-like objects with no body",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async () => ({
					ok: true,
					status: 200,
					body: null,
					async text() {
						return wrbLine(["response-like fallback"]);
					},
				}),
				async () => {
					const chunks = [];
					for await (const delta of mod.generateStream(
						cfg,
						"prompt",
						1,
						4,
						null,
						null,
					))
						chunks.push(delta);
					assert.deepEqual(chunks, ["response-like fallback"]);
				},
			);
		},
	],
	[
		"throws when streamed Gemini body has no parseable text",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const calls = [];
			await withFetch(
				async (url) => {
					const href = String(url);
					calls.push(href);
					if (href === "https://gemini.example/app")
						return new Response("<html>no fresh build label</html>", {
							status: 200,
						});
					return new Response("not parseable", { status: 502 });
				},
				async () => {
					try {
						for await (const _delta of mod.generateStream(
							cfg,
							"prompt",
							1,
							4,
							null,
							null,
						)) {
							throw new Error("stream should not yield");
						}
						throw new Error("expected parse failure");
					} catch (err) {
						assert.equal(err.code, "upstream_empty_response");
						assert.equal(err.status, 502);
						assert.equal(err.upstreamStatus, 502);
						assert.equal(err.rawLength, "not parseable".length);
					}
				},
			);
			assert.equal(
				calls.some((href) => href === "https://gemini.example/app"),
				true,
			);
		},
	],
	[
		"throws explicit stream upstream empty error for HTTP 200 responses",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "stale-stream-bl",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			await withFetch(
				async (url) => {
					if (String(url) === "https://gemini.example/app")
						return new Response("<html>no fresh build label</html>", {
							status: 200,
						});
					return new Response("stream completed without wrb text", {
						status: 200,
					});
				},
				async () => {
					try {
						for await (const _delta of mod.generateStream(
							cfg,
							"prompt",
							1,
							4,
							null,
							null,
						)) {
							throw new Error("stream should not yield");
						}
						throw new Error("expected upstream empty stream response");
					} catch (err) {
						assert.equal(err.code, "upstream_empty_response");
						assert.equal(err.status, 502);
						assert.equal(err.upstreamStatus, 200);
						assert.equal(
							err.rawLength,
							"stream completed without wrb text".length,
						);
					}
				},
			);
		},
	],
	[
		"refreshes Gemini build label and retries empty stream bodies",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "old-stream-bl",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 2,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const streamUrls = [];
			await withFetch(
				async (url) => {
					const href = String(url);
					if (href === "https://gemini.example/app")
						return new Response('<html>{"cfb2h":"fresh-stream-bl"}</html>', {
							status: 200,
						});
					streamUrls.push(href);
					if (streamUrls.length === 1)
						return new Response("not parseable yet", { status: 200 });
					return new Response(wrbLine(["after stream refresh"]), {
						status: 200,
					});
				},
				async () => {
					const chunks = [];
					for await (const delta of mod.generateStream(
						cfg,
						"prompt",
						1,
						4,
						null,
						null,
					))
						chunks.push(delta);
					assert.deepEqual(chunks, ["after stream refresh"]);
				},
			);
			assert.match(streamUrls[0], /bl=old-stream-bl/);
			assert.match(streamUrls[1], /bl=fresh-stream-bl/);
		},
	],
	[
		"adapts resolved models through the Gemini completion provider",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const provider = mod.createGeminiCompletionProvider(cfg, {
				accountRuntime: fakeRuntime([
					fakeLease(accountCfgFromBase(cfg, "provider-pro", "provider-hash")),
				]),
			});
			const rm = mod.resolveModel("gemini-3.1-pro", "gemini-3.5-flash");
			await withFetch(
				async (url, init) => {
					assert.match(String(url), /StreamGenerate/);
					const payload = new URLSearchParams(String(init.body)).get("f.req");
					const outer = JSON.parse(payload);
					const inner = JSON.parse(outer[1]);
					assert.match(payload, /provider prompt/);
					assert.match(payload, /file-ref/);
					assert.equal(
						init.headers["x-goog-ext-525001261-jspb"],
						'[1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4],null,null,1]',
					);
					assert.equal(init.headers["x-goog-ext-73010989-jspb"], "[0]");
					assert.equal(init.headers["x-goog-ext-73010990-jspb"], "[0]");
					assert.equal(
						JSON.parse(init.headers["x-goog-ext-525005358-jspb"])[0],
						inner[59],
					);
					return new Response(wrbLine(["provider answer"]), { status: 200 });
				},
				async () => {
					const text = await provider.generateText({
						prompt: "provider prompt",
						rm,
						fileRefs: [{ ref: "file-ref", name: "doc.txt" }],
					});
					assert.equal(text, "provider answer");
				},
			);
		},
	],
	[
		"logs Gemini routing fields through the completion provider",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: true,
			};
			const provider = mod.createGeminiCompletionProvider(cfg, {
				accountRuntime: fakeRuntime([
					fakeLease(accountCfgFromBase(cfg, "logging-pro", "logging-hash")),
				]),
			});
			const rm = mod.resolveModel(
				"gemini-3.1-pro-enhanced",
				"gemini-3.5-flash",
			);
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					await withFetch(
						async () =>
							new Response(wrbLine(["provider answer"]), { status: 200 }),
						async () => {
							const text = await provider.generateText({
								prompt: "secret prompt",
								rm,
								fileRefs: null,
							});
							assert.equal(text, "provider answer");
						},
					);
				},
			);
			const routeLog = logs.find((line) => line.includes("stage=gemini_route"));
			assert.match(routeLog, /model=gemini-3\.1-pro-enhanced/);
			assert.match(routeLog, /modelFamily=3/);
			assert.match(routeLog, /thinkingMode=4/);
			assert.match(routeLog, /enhancedMode=2/);
			assert.match(routeLog, /enhancedRouting=3/);
			assert.match(routeLog, /webModelHeader=true/);
			assert.equal(
				logs.some((line) => line.includes("secret prompt")),
				false,
			);
		},
	],
	[
		"streams text through the Gemini completion provider and rejects unresolved models",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const provider = mod.createGeminiCompletionProvider(cfg, {
				accountRuntime: fakeRuntime([
					fakeLease(accountCfgFromBase(cfg, "upload", "upload-hash")),
				]),
			});
			await withFetch(
				async () =>
					new Response(
						[wrbLine(["hello"]), wrbLine(["hello world"])].join("\n"),
						{ status: 200 },
					),
				async () => {
					const deltas = [];
					for await (const delta of provider.streamText(
						{
							prompt: "stream prompt",
							rm: {
								name: "gemini-3.5-flash",
								modeId: 1,
								thinkMode: 4,
								extra: null,
							},
							fileRefs: null,
						},
						{ signal: new AbortController().signal },
					)) {
						deltas.push(delta);
					}
					assert.deepEqual(deltas, ["hello", " world"]);
				},
			);
			await assert.rejects(
				() =>
					provider.generateText({
						prompt: "bad model",
						rm: { error: "model_not_found" },
						fileRefs: null,
					}),
				/model_not_found/,
			);
		},
	],
	[
		"forwards image resolution and text uploads through the Gemini completion provider",
		async () => {
			const cfg = {
				gemini_origin: "https://gemini.example",
				gemini_bl: "boq_test",
				cookie: "",
				sapisid: "",
				request_timeout_sec: 180,
				retry_attempts: 1,
				retry_delay_sec: 0,
				current_input_file_min_bytes: 1000000,
				upstream_socket: false,
				log_requests: false,
			};
			const provider = mod.createGeminiCompletionProvider(cfg, {
				accountRuntime: fakeRuntime([
					fakeLease(accountCfgFromBase(cfg, "upload", "upload-hash")),
				]),
			});
			assert.deepEqual(
				await provider.resolveAttachments(mod.createAttachmentPlan()),
				{
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
				},
			);

			const calls = [];
			await withFetch(
				async (url, init) => {
					calls.push({ url: String(url), body: init?.body });
					if (String(url) === "https://gemini.example/app") {
						return new Response('{"qKIAYe":"push-provider"}', { status: 200 });
					}
					if (String(url) === "https://content-push.googleapis.com/upload") {
						assert.equal(init.method, "POST");
						assert.equal(init.headers["X-Tenant-Id"], "bard-storage");
						assert.equal(init.headers.Cookie, undefined);
						assert.equal(init.headers.Authorization, undefined);
						assert.match(
							init.headers["Content-Type"],
							/^multipart\/form-data; boundary=/,
						);
						assert.match(
							new TextDecoder().decode(await bodyBytes(init.body)),
							/name="file"; filename="context\.txt"/,
						);
						return new Response("/uploaded/context-file", { status: 200 });
					}
					throw new Error(`unexpected upload URL: ${url}`);
				},
				async () => {
					const uploaded = await provider.uploadTextFile(
						"context text",
						"context.txt",
					);
					assert.deepEqual(uploaded, {
						ref: "/uploaded/context-file",
						name: "context.txt",
					});
				},
			);
			assert.deepEqual(
				calls.map((call) => call.url),
				[
					"https://gemini.example/app",
					"https://content-push.googleapis.com/upload",
				],
			);
		},
	],
	[
		"reuses one account lease across provider upload and text generation",
		async () => {
			const cfg = baseGeminiClientConfig({ cookie: "" });
			const lease = fakeLease(accountCfg("account-a", "hash-a"));
			const runtime = fakeRuntime([lease]);
			const seenConfigs = [];
			const provider = mod.createGeminiCompletionProvider(cfg, {
				accountRuntime: runtime,
				uploads: {
					async resolveAttachments(activeCfg) {
						seenConfigs.push(activeCfg);
						return {
							fileRefs: [{ ref: "/uploaded/file", name: "file.txt" }],
							imageFileRefs: null,
							genericFileRefs: [{ ref: "/uploaded/file", name: "file.txt" }],
							promptText: "",
							droppedNote: "",
							supportsFileRefs: true,
							usage: {
								uploadedFiles: 1,
								dedupedFiles: 0,
								uploadedBytes: 4,
								fileRefBytes: 4,
								inlinedFiles: 0,
								inlinedBytes: 0,
								droppedFiles: 0,
								multipartUploads: 1,
							},
						};
					},
				},
				client: {
					async generate(
						activeCfg,
						prompt,
						_modelId,
						_thinkMode,
						_extra,
						fileRefs,
					) {
						seenConfigs.push(activeCfg);
						assert.equal(prompt, "provider prompt");
						assert.deepEqual(fileRefs, [
							{ ref: "/uploaded/file", name: "file.txt" },
						]);
						return "lease answer";
					},
				},
			});

			assert.equal(provider.supportsAuthenticatedSession, true);
			const attachments = await provider.resolveAttachments(
				mod.createAttachmentPlan({
					files: [
						{ b64: "aGVsbG8=", mime: "text/plain", filename: "file.txt" },
					],
				}),
			);
			const text = await provider.generateText({
				prompt: "provider prompt",
				rm: providerResolvedModel(),
				fileRefs: attachments.fileRefs,
			});

			assert.equal(text, "lease answer");
			assert.equal(runtime.acquireCalls, 1);
			assert.equal(lease.successCalls, 1);
			assert.equal(lease.failureCalls, 0);
			assert.equal(lease.releaseCalls, 1);
			assert.equal(seenConfigs.length, 2);
			assert.equal(
				seenConfigs.every(
					(activeCfg) => activeCfg.gemini_account.accountId === "account-a",
				),
				true,
			);
		},
	],
	[
		"marks upload failures and releases the selected account lease",
		async () => {
			const uploadError = new Error("upload failed");
			const lease = fakeLease(accountCfg("upload-fail", "upload-fail-hash"));
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: fakeRuntime([lease]),
					uploads: {
						async uploadTextFile() {
							throw uploadError;
						},
					},
				},
			);

			let seenError;
			try {
				await provider.uploadTextFile("body", "context.txt");
			} catch (error) {
				seenError = error;
			}
			assert.equal(seenError, uploadError);
			assert.equal(lease.successCalls, 0);
			assert.equal(lease.failureCalls, 1);
			assert.equal(lease.releaseCalls, 1);
		},
	],
	[
		"delegates exact provider arguments and filters empty stream deltas",
		async () => {
			const calls = [];
			const logs = [];
			const cfg = baseGeminiClientConfig({
				log_requests: true,
				supports_authenticated_session: false,
			});
			const selectedCfg = accountCfgFromBase(cfg, "exact", "exact-hash");
			const leases = Array.from({ length: 5 }, () => fakeLease(selectedCfg));
			const provider = mod.createGeminiCompletionProvider(cfg, {
				accountRuntime: fakeRuntime(leases),
				client: {
					async generate(...args) {
						calls.push({ kind: "text", args });
						return "text result";
					},
					async generateRich(...args) {
						calls.push({ kind: "rich", args });
						return { text: "rich result", images: [] };
					},
					async *generateStream(...args) {
						calls.push({ kind: "stream", args });
						yield "";
						yield undefined;
						yield "visible";
						yield 7;
					},
				},
				uploads: {
					async resolveAttachments(...args) {
						calls.push({ kind: "attachments", args });
						return { fileRefs: null };
					},
					async uploadTextFile(...args) {
						calls.push({ kind: "upload", args });
						return { ref: "uploaded", name: args[2] };
					},
				},
			});
			const extra = { 31: 2, 80: 3 };
			const modelHeaders = { "x-model-route": "pro" };
			const rm = {
				name: "gemini-3.1-pro-enhanced",
				modeId: 3,
				thinkMode: 4,
				extra,
				modelHeaders,
			};
			const fileRefs = [{ ref: "file-ref", name: "doc.txt" }];
			const input = { prompt: "provider prompt", rm, fileRefs };

			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					assert.equal(provider.supportsAuthenticatedSession, true);
					assert.equal(await provider.generateText(input), "text result");
					assert.deepEqual(await provider.generateRich(input), {
						text: "rich result",
						images: [],
					});
					const richOptions = { hydrateGeneratedImageBytes: true };
					await provider.generateRich(input, richOptions);
					const signal = new AbortController().signal;
					const deltas = [];
					for await (const delta of provider.streamText(input, { signal }))
						deltas.push(delta);
					assert.deepEqual(deltas, ["visible", "7"]);
					const plan = mod.createAttachmentPlan();
					await provider.resolveAttachments(plan);
					assert.deepEqual(
						await provider.uploadTextFile("body", "context.txt"),
						{ ref: "uploaded", name: "context.txt" },
					);
				},
			);

			assert.deepEqual(calls[0].args, [
				selectedCfg,
				"provider prompt",
				3,
				4,
				extra,
				fileRefs,
				modelHeaders,
			]);
			assert.deepEqual(calls[1].args[7], {});
			assert.equal(calls[2].args[7].hydrateGeneratedImageBytes, true);
			assert.equal(calls[3].args[6].signal instanceof AbortSignal, true);
			assert.deepEqual(calls[4].args, [cfg, mod.createAttachmentPlan()]);
			assert.deepEqual(calls[5].args, [selectedCfg, "body", "context.txt"]);
			const routeLogs = logs.filter((line) =>
				line.includes("stage=gemini_route"),
			);
			assert.equal(routeLogs.length, 4);
			assert.match(routeLogs[0], /enhancedMode=2/);
			assert.match(routeLogs[3], /stream=true/);
		},
	],
	[
		"routes prompt threshold edges between anonymous and account generation",
		async () => {
			const anonymousRuntime = fakeRuntime([null]);
			const anonymousProvider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig({ current_input_file_min_bytes: 4 }),
				{
					accountRuntime: anonymousRuntime,
					client: {
						async generate(activeCfg) {
							assert.equal(activeCfg.gemini_account, undefined);
							return "anonymous edge";
						},
					},
				},
			);
			assert.equal(
				await anonymousProvider.generateText({
					prompt: "abcd",
					rm: providerResolvedModel(),
					fileRefs: null,
				}),
				"anonymous edge",
			);
			assert.equal(anonymousRuntime.acquireCalls, 0);

			const lease = fakeLease(accountCfg("threshold", "threshold-hash"));
			const accountRuntime = fakeRuntime([lease]);
			const accountProvider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig({ current_input_file_min_bytes: 4 }),
				{
					accountRuntime,
					client: {
						async generate(activeCfg) {
							assert.equal(activeCfg.gemini_account.accountId, "threshold");
							return "account edge";
						},
					},
				},
			);
			assert.equal(
				await accountProvider.generateText({
					prompt: "abcde",
					rm: providerResolvedModel(),
					fileRefs: null,
				}),
				"account edge",
			);
			assert.equal(accountRuntime.acquireCalls, 1);
			assert.equal(lease.successCalls, 1);
		},
	],
	[
		"falls back from anonymous errors to one account lease",
		async () => {
			const anonymousError = new Error("anonymous failed");
			const lease = fakeLease(accountCfg("fallback", "fallback-hash"));
			const runtime = fakeRuntime([lease]);
			const seenAccounts = [];
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: runtime,
					client: {
						async generate(activeCfg) {
							seenAccounts.push(activeCfg.gemini_account?.accountId || null);
							if (!activeCfg.gemini_account) throw anonymousError;
							return "fallback answer";
						},
					},
				},
			);

			assert.equal(
				await provider.generateText({
					prompt: "prompt",
					rm: providerResolvedModel(),
					fileRefs: null,
				}),
				"fallback answer",
			);
			assert.deepEqual(seenAccounts, [null, "fallback"]);
			assert.equal(runtime.acquireCalls, 1);
			assert.equal(lease.successCalls, 1);
			assert.equal(lease.failureCalls, 0);
			assert.equal(lease.releaseCalls, 1);
		},
	],
	[
		"returns account errors when anonymous fallback generation also fails",
		async () => {
			const anonymousError = new Error("anonymous failed");
			const accountError = new Error("account failed");
			const lease = fakeLease(
				accountCfg("fallback-fail", "fallback-fail-hash"),
			);
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: fakeRuntime([lease]),
					client: {
						async generate(activeCfg) {
							if (!activeCfg.gemini_account) throw anonymousError;
							throw accountError;
						},
					},
				},
			);

			let seenError;
			try {
				await provider.generateText({
					prompt: "prompt",
					rm: providerResolvedModel(),
					fileRefs: null,
				});
			} catch (error) {
				seenError = error;
			}
			assert.equal(seenError, accountError);
			assert.equal(lease.successCalls, 0);
			assert.equal(lease.failureCalls, 1);
			assert.equal(lease.releaseCalls, 1);
		},
	],
	[
		"preserves anonymous errors when fallback has no account",
		async () => {
			const anonymousError = new Error("anonymous unavailable");
			const runtime = fakeRuntime([null]);
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: runtime,
					client: {
						async generate() {
							throw anonymousError;
						},
					},
				},
			);

			let seenError;
			try {
				await provider.generateText({
					prompt: "prompt",
					rm: providerResolvedModel(),
					fileRefs: null,
				});
			} catch (error) {
				seenError = error;
			}
			assert.equal(seenError, anonymousError);
			assert.equal(runtime.acquireCalls, 1);
		},
	],
	[
		"does not acquire fallback accounts for anonymous aborts",
		async () => {
			const abort = Object.assign(new Error("cancelled"), {
				name: "AbortError",
			});
			const runtime = fakeRuntime([null]);
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: runtime,
					client: {
						async generate() {
							throw abort;
						},
					},
				},
			);

			await assert.rejects(
				() =>
					provider.generateText({
						prompt: "prompt",
						rm: providerResolvedModel(),
						fileRefs: null,
					}),
				/cancelled/,
			);
			assert.equal(runtime.acquireCalls, 0);
		},
	],
	[
		"falls back account streams only before anonymous output",
		async () => {
			const lease = fakeLease(accountCfg("stream-fallback", "stream-hash"));
			const runtime = fakeRuntime([lease]);
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: runtime,
					client: {
						async *generateStream(activeCfg) {
							if (!activeCfg.gemini_account)
								throw new Error("anonymous stream failed");
							yield "account stream";
						},
					},
				},
			);
			const output = [];
			for await (const delta of provider.streamText({
				prompt: "prompt",
				rm: providerResolvedModel(),
				fileRefs: null,
			}))
				output.push(delta);
			assert.deepEqual(output, ["account stream"]);
			assert.equal(runtime.acquireCalls, 1);
			assert.equal(lease.successCalls, 1);
			assert.equal(lease.releaseCalls, 1);
		},
	],
	[
		"preserves anonymous stream errors when fallback has no account",
		async () => {
			const anonymousError = new Error("anonymous stream unavailable");
			const runtime = fakeRuntime([null]);
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: runtime,
					client: {
						async *generateStream() {
							yield* [];
							throw anonymousError;
						},
					},
				},
			);

			let seenError;
			try {
				for await (const _ of provider.streamText({
					prompt: "prompt",
					rm: providerResolvedModel(),
					fileRefs: null,
				})) {
					throw new Error("unexpected stream output");
				}
			} catch (error) {
				seenError = error;
			}
			assert.equal(seenError, anonymousError);
			assert.equal(runtime.acquireCalls, 1);
		},
	],
	[
		"marks account stream failures after anonymous fallback",
		async () => {
			const anonymousError = new Error("anonymous stream failed");
			const accountError = new Error("account stream failed");
			const lease = fakeLease(
				accountCfg("stream-failover", "stream-failover-hash"),
			);
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: fakeRuntime([lease]),
					client: {
						async *generateStream(activeCfg) {
							yield* [];
							if (!activeCfg.gemini_account) throw anonymousError;
							throw accountError;
						},
					},
				},
			);

			let seenError;
			try {
				for await (const _ of provider.streamText({
					prompt: "prompt",
					rm: providerResolvedModel(),
					fileRefs: null,
				})) {
					throw new Error("unexpected stream output");
				}
			} catch (error) {
				seenError = error;
			}
			assert.equal(seenError, accountError);
			assert.equal(lease.successCalls, 0);
			assert.equal(lease.failureCalls, 1);
			assert.equal(lease.releaseCalls, 1);
		},
	],
	[
		"does not fall back after anonymous stream output",
		async () => {
			const runtime = fakeRuntime([null]);
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: runtime,
					client: {
						async *generateStream() {
							yield "partial";
							throw new Error("stream interrupted");
						},
					},
				},
			);
			const output = [];
			await assert.rejects(async () => {
				for await (const delta of provider.streamText({
					prompt: "prompt",
					rm: providerResolvedModel(),
					fileRefs: null,
				}))
					output.push(delta);
			}, /stream interrupted/);
			assert.deepEqual(output, ["partial"]);
			assert.equal(runtime.acquireCalls, 0);
		},
	],
	[
		"uses the default unresolved-model error",
		async () => {
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
			);
			await assert.rejects(
				() => provider.generateRich({ prompt: "bad", rm: {}, fileRefs: null }),
				/model is not resolved/,
			);
		},
	],
	[
		"prefers anonymous generation without acquiring an available account",
		async () => {
			let generatedConfig;
			const runtime = fakeRuntime([null]);
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: runtime,
					client: {
						async generate(activeCfg) {
							generatedConfig = activeCfg;
							return "anonymous";
						},
					},
				},
			);

			assert.equal(
				await provider.generateText({
					prompt: "prompt",
					rm: providerResolvedModel(),
					fileRefs: null,
				}),
				"anonymous",
			);
			assert.equal(generatedConfig.cookie, "");
			assert.equal(runtime.acquireCalls, 0);
		},
	],
	[
		"returns typed authenticated-session errors when no pool is configured",
		async () => {
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
			);
			await assert.rejects(async () => {
				try {
					await provider.generateText({
						prompt: "prompt",
						rm: providerProModel(),
						fileRefs: null,
					});
				} catch (error) {
					assert.equal(error.status, 422);
					assert.equal(error.code, "gemini_authenticated_session_required");
					assert.equal(error.reason, "pro_model");
					throw error;
				}
			}, /authenticated Gemini session/);
		},
	],
	[
		"returns sanitized no-account errors for account-required models",
		async () => {
			let generated = false;
			const runtime = fakeRuntime([null]);
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: runtime,
					client: {
						async generate() {
							generated = true;
							return "unexpected";
						},
					},
				},
			);

			await assert.rejects(async () => {
				try {
					await provider.generateText({
						prompt: "prompt",
						rm: providerProModel(),
						fileRefs: null,
					});
				} catch (error) {
					assert.equal(error.status, 503);
					assert.equal(error.code, "no_available_gemini_account");
					assert.doesNotMatch(error.message, /psid|cookie|SNlM0e|SAPISID/i);
					throw error;
				}
			}, /no available Gemini account/);
			assert.equal(generated, false);
			assert.equal(runtime.acquireCalls, 1);
		},
	],
	[
		"finalizes account streams only after iterator completion",
		async () => {
			const lease = fakeLease(accountCfg("stream-account", "stream-hash"));
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: fakeRuntime([lease]),
					client: {
						async *generateStream(activeCfg) {
							assert.equal(
								activeCfg.gemini_account.accountId,
								"stream-account",
							);
							yield "a";
							yield "b";
						},
					},
				},
			);

			const iterator = provider
				.streamText({
					prompt: "stream",
					rm: providerProModel(),
					fileRefs: null,
				})
				[Symbol.asyncIterator]();

			assert.deepEqual(await iterator.next(), { value: "a", done: false });
			assert.equal(lease.successCalls, 0);
			assert.equal(lease.releaseCalls, 0);
			assert.deepEqual(await iterator.next(), { value: "b", done: false });
			assert.deepEqual(await iterator.next(), { value: undefined, done: true });
			assert.equal(lease.successCalls, 1);
			assert.equal(lease.failureCalls, 0);
			assert.equal(lease.releaseCalls, 1);
		},
	],
	[
		"marks account stream failures and releases the selected lease",
		async () => {
			const lease = fakeLease(accountCfg("stream-fail", "hash-fail"));
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: fakeRuntime([lease]),
					client: {
						async *generateStream() {
							yield "partial";
							const err = new Error("stream broke");
							err.code = "stream_broke";
							throw err;
						},
					},
				},
			);

			const seen = [];
			await assert.rejects(async () => {
				for await (const delta of provider.streamText({
					prompt: "stream",
					rm: providerProModel(),
					fileRefs: null,
				})) {
					seen.push(delta);
				}
			}, /stream broke/);
			assert.deepEqual(seen, ["partial"]);
			assert.equal(lease.successCalls, 0);
			assert.equal(lease.failureCalls, 1);
			assert.equal(lease.releaseCalls, 1);
		},
	],
	[
		"keeps successful results when background outcome persistence fails",
		async () => {
			const background = [];
			const lease = fakeLease(accountCfg("success-write-fail", "hash"), {
				async markSuccess() {
					this.successCalls += 1;
					throw new Error("D1 write failed");
				},
			});
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig({
					execution_ctx: {
						waitUntil(promise) {
							background.push(promise);
						},
					},
				}),
				{
					accountRuntime: fakeRuntime([lease]),
					client: {
						async generate() {
							return "ok";
						},
					},
				},
			);

			assert.equal(
				await provider.generateText({
					prompt: "test",
					rm: providerProModel(),
					fileRefs: null,
				}),
				"ok",
			);
			assert.equal(lease.successCalls, 1);
			assert.equal(lease.failureCalls, 0);
			assert.equal(lease.releaseCalls, 1);
			assert.equal(background.length, 1);
			await Promise.all(background);
		},
	],
	[
		"keeps account results when waitUntil registration throws",
		async () => {
			const lease = fakeLease(accountCfg("wait-until-fail", "hash"));
			const logs = [];
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig({
					log_requests: true,
					execution_ctx: {
						waitUntil() {
							throw new Error("waitUntil unavailable");
						},
					},
				}),
				{
					accountRuntime: fakeRuntime([lease]),
					client: {
						async generate() {
							return "ok";
						},
					},
				},
			);

			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					assert.equal(
						await provider.generateText({
							prompt: "test",
							rm: providerProModel(),
							fileRefs: null,
						}),
						"ok",
					);
				},
			);
			assert.equal(lease.successCalls, 1);
			assert.equal(lease.releaseCalls, 1);
			assert.equal(
				logs.some((line) => line.includes("waitUntil registration failed")),
				true,
			);
		},
	],
	[
		"preserves the original upstream error when outcome persistence fails",
		async () => {
			const upstreamError = new Error("upstream failed");
			const lease = fakeLease(accountCfg("failure-write-fail", "hash"), {
				async markFailure() {
					this.failureCalls += 1;
					throw new Error("D1 write failed");
				},
			});
			const provider = mod.createGeminiCompletionProvider(
				baseGeminiClientConfig(),
				{
					accountRuntime: fakeRuntime([lease]),
					client: {
						async generate() {
							throw upstreamError;
						},
					},
				},
			);

			let seenError;
			try {
				await provider.generateText({
					prompt: "test",
					rm: providerProModel(),
					fileRefs: null,
				});
			} catch (error) {
				seenError = error;
			}
			assert.equal(seenError, upstreamError);
			assert.equal(lease.failureCalls, 1);
			assert.equal(lease.releaseCalls, 1);
		},
	],
];

async function bodyBytes(body) {
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body))
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	return new Response(body).bytes();
}

function providerResolvedModel() {
	return {
		name: "gemini-3.5-flash",
		modeId: 1,
		thinkMode: 4,
		extra: null,
		modelHeaders: null,
	};
}

function providerProModel() {
	return {
		name: "gemini-3.1-pro",
		modeId: 3,
		thinkMode: 4,
		extra: null,
		modelHeaders: null,
	};
}

function accountCfgFromBase(base, accountId, cookieHash) {
	return {
		...base,
		gemini_account: {
			accountId,
			rowId: `row-${accountId}`,
			cookieHash,
		},
	};
}

function accountCfg(accountId, cookieHash) {
	return baseGeminiClientConfig({
		cookie: `__Secure-1PSID=psid-${accountId}; __Secure-1PSIDTS=ts-${accountId}`,
		sapisid: "",
		gemini_account: {
			accountId,
			rowId: `row-${accountId}`,
			cookieHash,
		},
	});
}

function fakeRuntime(leases) {
	return {
		acquireCalls: 0,
		async acquireLease() {
			this.acquireCalls += 1;
			return leases.shift() ?? null;
		},
	};
}

function fakeLease(config, overrides = {}) {
	return {
		accountId: config.gemini_account.accountId,
		rowId: config.gemini_account.rowId,
		selectedCookieHash: config.gemini_account.cookieHash,
		config,
		successCalls: 0,
		failureCalls: 0,
		releaseCalls: 0,
		async recordPageState() {
			return { changed: false };
		},
		async refreshForRetry() {
			return { changed: false, reason: "account_missing" };
		},
		async markSuccess() {
			this.successCalls += 1;
		},
		async markFailure() {
			this.failureCalls += 1;
		},
		release() {
			this.releaseCalls += 1;
		},
		...overrides,
	};
}
