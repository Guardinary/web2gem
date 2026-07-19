import { afterEach, beforeEach, describe, test } from "vitest";
import {
	generate,
	generateRich,
	generateStream,
} from "../../../../src/gemini/client";
import { resetGeminiBuildLabelCacheForTest } from "../../../../src/gemini/client/retry";
import type { ErrorWithMetadata } from "../../../../src/shared/types";
import { assert } from "../../assertions.js";
import { withFetch } from "../../_support/globals.js";
import { baseGeminiClientConfig } from "../_support/client-fixtures.js";

type SemanticError = ErrorWithMetadata & {
	geminiSource?: string;
	geminiCode?: string;
};

function fatalWrbLine(code: number, location = "inner") {
	const inner: unknown[] = [null, null, null, null, []];
	const envelope: unknown[] = ["wrb.fr", null, JSON.stringify(inner)];
	const target = location === "envelope" ? envelope : inner;
	const codeEntry: unknown[] = [];
	codeEntry[1] = [code];
	const fatalParts: unknown[] = [];
	fatalParts[2] = [codeEntry];
	target[5] = fatalParts;
	if (location !== "envelope") envelope[2] = JSON.stringify(inner);
	return JSON.stringify([envelope]);
}

async function assertRejectsWithCode(
	run: () => unknown | PromiseLike<unknown>,
	code: string,
): Promise<SemanticError> {
	try {
		await run();
	} catch (err) {
		if (!(err instanceof Error)) throw err;
		const semanticError: SemanticError = err;
		assert.equal(semanticError.code, code);
		return semanticError;
	}
	throw new Error(`expected rejection with code ${code}`);
}

describe("Gemini semantic error precedence", () => {
	beforeEach(resetGeminiBuildLabelCacheForTest);
	afterEach(resetGeminiBuildLabelCacheForTest);

	test("surfaces fatal semantics before text empty-response handling", async () => {
		const cfg = baseGeminiClientConfig();
		let calls = 0;
		await withFetch(
			async (url: RequestInfo | URL) => {
				calls += 1;
				assert.match(String(url), /StreamGenerate/);
				return new Response(fatalWrbLine(1037), { status: 200 });
			},
			async () => {
				const err = await assertRejectsWithCode(
					() => generate(cfg, "limited", 1, false, null),
					"gemini_semantic_error",
				);
				assert.equal(err.reason, "usage_limit_exceeded");
				assert.equal(err.geminiSource, "stream_generate");
				assert.equal(err.geminiCode, "1037");
			},
		);
		assert.equal(calls, 1);
	});

	test("surfaces fatal semantics before stream empty-response handling", async () => {
		const cfg = baseGeminiClientConfig();
		let calls = 0;
		await withFetch(
			async (url: RequestInfo | URL) => {
				calls += 1;
				assert.match(String(url), /StreamGenerate/);
				return new Response(`${fatalWrbLine(1052)}\n`, { status: 200 });
			},
			async () => {
				let emitted = false;
				const err = await assertRejectsWithCode(async () => {
					for await (const _delta of generateStream(
						cfg,
						"invalid header",
						1,
						false,
						null,
					)) {
						emitted = true;
					}
				}, "gemini_semantic_error");
				assert.equal(emitted, false);
				assert.equal(err.reason, "model_header_invalid");
				assert.equal(err.geminiCode, "1052");
			},
		);
		assert.equal(calls, 1);
	});

	test("maps rich fatal responses to an image provider error", async () => {
		const cfg = baseGeminiClientConfig();
		let calls = 0;
		await withFetch(
			async (url: RequestInfo | URL) => {
				calls += 1;
				assert.match(String(url), /StreamGenerate/);
				return new Response(fatalWrbLine(1013), { status: 200 });
			},
			async () => {
				const err = await assertRejectsWithCode(
					() => generateRich(cfg, "draw image", 1, false, null),
					"upstream_image_provider_error",
				);
				assert.equal(err.reason, "temporary_model_error");
				assert.equal(err.geminiSource, "stream_generate");
				assert.equal(err.geminiCode, "1013");
			},
		);
		assert.equal(calls, 1);
	});

	test("maps rich empty responses to an image generation error", async () => {
		const cfg = baseGeminiClientConfig();
		const calls: string[] = [];
		await withFetch(
			async (url: RequestInfo | URL) => {
				const href = String(url);
				calls.push(href);
				if (href.includes("StreamGenerate"))
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
				if (href === "https://gemini.example/app")
					return new Response("no fresh build label");
				throw new Error(`unexpected fetch ${href}`);
			},
			async () => {
				await assertRejectsWithCode(
					() => generateRich(cfg, "draw image", 1, false, null),
					"upstream_image_generation_empty",
				);
			},
		);
		assert.equal(calls.length, 2);
		assert.match(calls[0] ?? "", /StreamGenerate/);
		assert.equal(calls[1], "https://gemini.example/app");
	});
});
