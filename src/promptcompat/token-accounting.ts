export type TokenCharCounts = {
	asciiChars: number;
	nonASCIIChars: number;
	hasText?: boolean;
};

export type PreparedTokenText = {
	text: string;
	tokens: number;
	counts: TokenCharCounts & { hasText: boolean };
};

export type TokenCounter = {
	append: (text: unknown) => void;
	tokens: () => number;
	counts: () => TokenCharCounts & { hasText: boolean };
};

export function tokenEst(value: unknown): number {
	const text = asTokenText(value);
	if (!text) return 0;
	const counts = tokenCharCounts(text);
	return tokenCountFromCharCounts(counts.asciiChars, counts.nonASCIIChars);
}

export function tokenCharCounts(text: unknown): TokenCharCounts {
	const source = String(text || "");
	const firstNonASCII = firstNonASCIIIndex(source);
	if (firstNonASCII < 0) return { asciiChars: source.length, nonASCIIChars: 0 };
	let asciiChars = 0;
	let nonASCIIChars = 0;
	if (firstNonASCII > 0) asciiChars = firstNonASCII;
	for (let i = Math.max(0, firstNonASCII); i < source.length; i++) {
		const code = source.charCodeAt(i);
		if (code < 128) asciiChars += 1;
		else {
			nonASCIIChars += 1;
			if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
				const next = source.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) i += 1;
			}
		}
	}
	return { asciiChars, nonASCIIChars };
}

export function tokenCountFromCharCounts(
	asciiChars: number,
	nonASCIIChars: number,
): number {
	const count =
		Math.floor(asciiChars / 4) + Math.floor((nonASCIIChars * 10 + 7) / 13);
	return count < 1 ? 1 : count;
}

export function createTokenCounter(): TokenCounter {
	let asciiChars = 0;
	let nonASCIIChars = 0;
	let hasText = false;
	let pendingHighSurrogate = false;
	return {
		append(text: unknown) {
			const source = asTokenText(text);
			if (!source) return;
			hasText = true;
			const firstNonASCII = firstNonASCIIIndex(source);
			if (firstNonASCII < 0) {
				asciiChars += source.length;
				pendingHighSurrogate = false;
				return;
			}
			if (firstNonASCII > 0) {
				asciiChars += firstNonASCII;
				pendingHighSurrogate = false;
			}
			for (let i = Math.max(0, firstNonASCII); i < source.length; i++) {
				const code = source.charCodeAt(i);
				if (pendingHighSurrogate) {
					pendingHighSurrogate = false;
					if (code >= 0xdc00 && code <= 0xdfff) continue;
				}
				if (code < 128) {
					asciiChars += 1;
				} else {
					nonASCIIChars += 1;
					if (code >= 0xd800 && code <= 0xdbff) {
						if (i + 1 < source.length) {
							const next = source.charCodeAt(i + 1);
							if (next >= 0xdc00 && next <= 0xdfff) i += 1;
						} else {
							pendingHighSurrogate = true;
						}
					}
				}
			}
		},
		tokens() {
			return hasText ? tokenCountFromCharCounts(asciiChars, nonASCIIChars) : 0;
		},
		counts() {
			return { asciiChars, nonASCIIChars, hasText };
		},
	};
}

export function addTokenCharCounts<
	T extends TokenCharCounts & { hasText: boolean },
>(target: T, source: TokenCharCounts | null | undefined): T {
	if (!source?.hasText) return target;
	target.asciiChars += source.asciiChars || 0;
	target.nonASCIIChars += source.nonASCIIChars || 0;
	target.hasText = true;
	return target;
}

export function emptyTokenCounts(): TokenCharCounts & { hasText: boolean } {
	return { asciiChars: 0, nonASCIIChars: 0, hasText: false };
}

export function combinedTokenCount(
	completionCounts: TokenCharCounts | null | undefined,
	extraTokenCounter: Pick<TokenCounter, "counts">,
): number {
	const counts = addTokenCharCounts(emptyTokenCounts(), completionCounts);
	addTokenCharCounts(counts, extraTokenCounter.counts());
	return tokenCountFromCounts(counts);
}

export function tokenCountFromCounts(
	counts: TokenCharCounts | null | undefined,
): number {
	return counts?.hasText
		? tokenCountFromCharCounts(
				counts.asciiChars || 0,
				counts.nonASCIIChars || 0,
			)
		: 0;
}

export function buildTextWithTokens(
	parts: unknown[] | null | undefined,
	keepText = true,
): PreparedTokenText {
	const out: string[] | null = keepText ? [] : null;
	const counter = createTokenCounter();
	for (const part of parts || []) {
		const text = asTokenText(part);
		if (!text) continue;
		if (out) out.push(text);
		counter.append(text);
	}
	const counts = counter.counts();
	return {
		text: out ? out.join("") : "",
		tokens: tokenCountFromCounts(counts),
		counts,
	};
}

export function asTokenText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return asTokenText(value[0]);
	if (value == null) return "";
	return String(value);
}

function firstNonASCIIIndex(source: string): number {
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) > 0x7f) return i;
	}
	return -1;
}
