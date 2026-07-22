import { isRecord } from "../shared/types";
import { GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT } from "../toolcall/prompt-format";
import type { PreparedTokenText, TokenCharCounts } from "./token-accounting";
import {
	addTokenCharCounts,
	asTokenText,
	buildTextWithTokens,
	tokenCharCounts,
	tokenCountFromCounts,
} from "./token-accounting";

type TokenCountsWithTextFlag = TokenCharCounts & { hasText: boolean };

export function structuredInstruction(requirement: unknown): string {
	if (!isRecord(requirement)) return "";
	return typeof requirement.instruction === "string"
		? requirement.instruction
		: "";
}

export function withGeminiNativeHiddenToolsPromptWithTokens(
	prompt: unknown,
	keepText = true,
	insertOffset?: number | null,
): PreparedTokenText {
	const text = String(prompt || "");
	const prepared = promptWithHiddenToolsPrompt(text, insertOffset);
	return buildTextWithTokens([prepared], keepText);
}

export function appendTextToPreparedWithTokens(
	prepared: PreparedTokenText,
	parts: readonly unknown[] | null | undefined,
	keepText = true,
): PreparedTokenText {
	const counts: TokenCountsWithTextFlag = {
		asciiChars: 0,
		nonASCIIChars: 0,
		hasText: false,
	};
	addTokenCharCounts(counts, prepared.counts);
	const out = keepText ? [prepared.text] : null;
	for (const part of parts || []) {
		const partText = asTokenText(part);
		if (!partText) continue;
		const partCounts = tokenCharCounts(partText);
		addTokenCharCounts(counts, { ...partCounts, hasText: true });
		if (out) out.push(partText);
	}
	return {
		text: out ? out.join("") : "",
		tokens: tokenCountFromCounts(counts),
		counts,
	};
}

export function withGeminiNativeHiddenToolsPromptForPrepared(
	prepared: PreparedTokenText,
	keepText = true,
	insertOffset?: number | null,
): PreparedTokenText {
	if (!prepared.counts.hasText)
		return keepText ? prepared : { ...prepared, text: "" };
	if (keepText)
		return withGeminiNativeHiddenToolsPromptWithTokens(
			prepared.text,
			keepText,
			insertOffset,
		);
	return appendTextToPreparedWithTokens(
		prepared,
		["\n\n", GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT],
		false,
	);
}

function promptWithHiddenToolsPrompt(
	prompt: unknown,
	insertOffset?: number | null,
): string {
	const text = String(prompt || "");
	if (!text.trim()) return text;
	const offset = validInsertOffset(text, insertOffset);
	if (offset == null)
		return [GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT, text.trimEnd()].join("\n\n");
	const before = text.slice(0, offset).trimEnd();
	const after = text.slice(offset).trimStart();
	return [before, GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT, after]
		.filter(Boolean)
		.join("\n\n");
}

function validInsertOffset(text: string, insertOffset: unknown): number | null {
	if (typeof insertOffset !== "number" || !Number.isFinite(insertOffset))
		return null;
	const offset = Math.floor(insertOffset);
	if (offset <= 0 || offset >= text.length) return null;
	return offset;
}

export function appendStructuredOutputInstructionWithTokens(
	prompt: unknown,
	requirement: unknown,
	keepText = true,
): PreparedTokenText {
	const instruction = structuredInstruction(requirement);
	if (!instruction) {
		const text = prompt || "";
		return buildTextWithTokens([text], keepText);
	}
	const base = String(prompt || "").trimEnd();
	const prepared = base
		? buildTextWithTokens([base, "\n\n", instruction], keepText)
		: buildTextWithTokens([instruction], keepText);
	return prepared;
}

export function appendStructuredOutputInstructionToPrepared(
	prepared: PreparedTokenText,
	requirement: unknown,
	keepText = true,
): PreparedTokenText {
	const instruction = structuredInstruction(requirement);
	if (!instruction) {
		return keepText ? prepared : { ...prepared, text: "" };
	}
	const countsSource = prepared.counts;
	const text = prepared.text;
	if (keepText && text.trimEnd() !== text) {
		return appendStructuredOutputInstructionWithTokens(
			prepared.text,
			requirement,
			keepText,
		);
	}
	const parts: string[] = [];
	const counts: TokenCountsWithTextFlag = {
		asciiChars: 0,
		nonASCIIChars: 0,
		hasText: false,
	};
	addTokenCharCounts(counts, countsSource);
	if (countsSource.hasText) {
		parts.push(text || "");
		const sepCounts = tokenCharCounts("\n\n");
		addTokenCharCounts(counts, { ...sepCounts, hasText: true });
		if (keepText) parts.push("\n\n");
	}
	const instructionCounts = tokenCharCounts(instruction);
	addTokenCharCounts(counts, { ...instructionCounts, hasText: !!instruction });
	if (keepText) parts.push(instruction);
	return {
		text: keepText ? parts.join("") : "",
		tokens: tokenCountFromCounts(counts),
		counts,
	};
}
