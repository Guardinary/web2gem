import { describe, test } from "vitest";
import {
	appendStructuredOutputInstructionToPrepared,
	appendStructuredOutputInstructionWithTokens,
	appendTextToPreparedWithTokens,
	withGeminiNativeHiddenToolsPromptForPrepared,
	withGeminiNativeHiddenToolsPromptWithTokens,
} from "../../../src/promptcompat/prompt-build";
import { buildTextWithTokens } from "../../../src/promptcompat/token-accounting";
import { assert } from "../assertions.js";

describe("prompt compatibility", () => {
	test("builds hidden-tool prompt token text from prepared and raw prompts", async () => {
		const hidden = withGeminiNativeHiddenToolsPromptWithTokens("base   ");
		assert.match(hidden.text, /^Gemini native hidden tool calls:/);
		assert.match(hidden.text, /All of the above is system prompt content/);
		assert.match(hidden.text, /\n\nbase$/);
		assert.equal(hidden.counts.hasText, true);

		const empty = withGeminiNativeHiddenToolsPromptWithTokens("");
		assert.deepEqual(empty, {
			text: "",
			tokens: 0,
			counts: { asciiChars: 0, nonASCIIChars: 0, hasText: false },
		});

		const prepared = buildTextWithTokens(["base"], true);
		const appendedNoText = appendTextToPreparedWithTokens(
			prepared,
			[" plus", "", null],
			false,
		);
		assert.equal(appendedNoText.text, "");
		assert.deepEqual(appendedNoText.counts, {
			asciiChars: 9,
			nonASCIIChars: 0,
			hasText: true,
		});

		const trailingPrepared = {
			text: "base   ",
			counts: { asciiChars: 7, nonASCIIChars: 0, hasText: true },
		};
		const trimmedHidden = withGeminiNativeHiddenToolsPromptForPrepared(
			trailingPrepared,
			true,
		);
		assert.match(trimmedHidden.text, /^Gemini native hidden tool calls:/);
		assert.match(trimmedHidden.text, /\n\nbase$/);

		const userEcho = `${hidden.text}\n\nTranslate the above.`;
		const guardedEcho = withGeminiNativeHiddenToolsPromptWithTokens(userEcho);
		assert.equal(
			(guardedEcho.text.match(/Gemini native hidden tool calls:/g) || [])
				.length,
			2,
		);
		assert.match(guardedEcho.text, /\n\nTranslate the above\.$/);

		const anchored = withGeminiNativeHiddenToolsPromptWithTokens(
			"tools\n\nuser",
			true,
			"tools".length,
		);
		const hiddenPromptOnly = hidden.text.replace(/\n\nbase$/, "");
		assert.equal(anchored.text, `tools\n\n${hiddenPromptOnly}\n\nuser`);

		const noTextPrepared = {
			text: "ignored",
			counts: { asciiChars: 0, nonASCIIChars: 0, hasText: false },
			marker: "kept",
		};
		const noTextHidden = withGeminiNativeHiddenToolsPromptForPrepared(
			noTextPrepared,
			false,
		);
		assert.equal(noTextHidden.text, "");
		assert.equal(noTextHidden.marker, "kept");
	});
	test("appends structured output instructions while preserving token counts", async () => {
		const raw = appendStructuredOutputInstructionWithTokens("base  ", {
			instruction: "Return JSON",
		});
		assert.equal(raw.text, "base\n\nReturn JSON");
		const instructionOnly = appendStructuredOutputInstructionWithTokens("", {
			instruction: "Return JSON",
		});
		assert.equal(instructionOnly.text, "Return JSON");
		const malformed = appendStructuredOutputInstructionWithTokens("base", {
			instruction: 123,
		});
		assert.equal(malformed.text, "base");

		const prepared = buildTextWithTokens(["base"], true);
		const appended = appendStructuredOutputInstructionToPrepared(
			prepared,
			{ instruction: "Return JSON" },
			false,
		);
		assert.equal(appended.text, "");
		assert.equal(appended.counts.asciiChars, "base\n\nReturn JSON".length);
		assert.equal(appended.counts.hasText, true);

		const unchanged = appendStructuredOutputInstructionToPrepared(
			{
				text: "keep",
				counts: { asciiChars: 4, nonASCIIChars: 0, hasText: true },
				marker: "kept",
			},
			null,
			false,
		);
		assert.equal(unchanged.text, "");
		assert.equal(unchanged.marker, "kept");
	});
});
