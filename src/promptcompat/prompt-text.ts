import {
	createPromptByteLengthSniffer,
	createTokenCounter,
	type PromptByteLengthBounded,
	type TokenCharCounts,
} from "../shared/tokens";

export type PromptMetadata = {
	hasToolPrompt: boolean;
	hasToolInstructions: boolean;
};

export type PromptBuildResult = {
	text: string;
	byteCheck: PromptByteLengthBounded | null;
	tokens: number;
	counts: TokenCharCounts & { hasText: boolean };
	latestInputText: string;
	hiddenPromptInsertOffset: number | null;
	metadata: PromptMetadata;
};

export type PromptAccumulatorResult = {
	text: string;
	byteCheck: PromptByteLengthBounded | null;
	tokens: number;
	counts: TokenCharCounts & { hasText: boolean };
};

export function createPromptPartAccumulator(maxBytes?: number | null): {
	add: (part: unknown) => void;
	length: () => number;
	text: () => string;
	result: () => PromptAccumulatorResult;
} {
	const parts: string[] = [];
	let textLength = 0;
	const sniffer =
		maxBytes == null ? null : createPromptByteLengthSniffer(maxBytes);
	const tokenCounter = createTokenCounter();
	return {
		add(part: unknown) {
			if (!part) return;
			const text = String(part);
			if (!text) return;
			if (parts.length) {
				if (sniffer) sniffer.append("\n\n");
				tokenCounter.append("\n\n");
				textLength += 2;
			}
			if (sniffer) sniffer.append(text);
			tokenCounter.append(text);
			textLength += text.length;
			parts.push(text);
		},
		length() {
			return textLength;
		},
		text() {
			return parts.join("\n\n");
		},
		result(): PromptAccumulatorResult {
			return {
				text: parts.join("\n\n"),
				byteCheck: sniffer ? sniffer.result() : null,
				tokens: tokenCounter.tokens(),
				counts: tokenCounter.counts(),
			};
		},
	};
}
