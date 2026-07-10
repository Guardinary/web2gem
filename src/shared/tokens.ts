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

export type PromptByteLengthBounded = {
	bytes: number;
	exceeded: boolean;
	exact: boolean;
	maxBytes: number;
};

export type PromptByteLengthSniffer = {
	append: (text: unknown) => void;
	result: () => PromptByteLengthBounded;
	exceeded: () => boolean;
};

export function tokenEst(s: unknown): number {
	const text = asTokenText(s);
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
	const n =
		Math.floor(asciiChars / 4) + Math.floor((nonASCIIChars * 10 + 7) / 13);
	return n < 1 ? 1 : n;
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

export function asTokenText(v: unknown): string {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) return asTokenText(v[0]);
	if (v == null) return "";
	return String(v);
}

function firstNonASCIIIndex(source: string): number {
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) > 0x7f) return i;
	}
	return -1;
}

export function promptByteLength(v: unknown): number {
	const text = asTokenText(v);
	if (!text) return 0;
	if (firstNonASCIIIndex(text) < 0) return text.length;
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i += 1;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

export function promptByteLengthBounded(
	v: unknown,
	maxBytes: number,
): PromptByteLengthBounded {
	const text = asTokenText(v);
	const limit = Math.max(0, Math.floor(maxBytes));
	if (!text) return { bytes: 0, exceeded: false, exact: true, maxBytes: limit };
	if (text.length > limit)
		return { bytes: limit + 1, exceeded: true, exact: false, maxBytes: limit };
	if (firstNonASCIIIndex(text) < 0)
		return {
			bytes: text.length,
			exceeded: text.length > limit,
			exact: true,
			maxBytes: limit,
		};
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i += 1;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
		if (bytes > limit)
			return { bytes, exceeded: true, exact: false, maxBytes: limit };
	}
	return { bytes, exceeded: false, exact: true, maxBytes: limit };
}

export function promptByteLengthGreaterThan(
	v: unknown,
	maxBytes: number,
): boolean {
	return promptByteLengthBounded(v, maxBytes).exceeded;
}

export function createPromptByteLengthSniffer(
	maxBytes: number,
): PromptByteLengthSniffer {
	const limit = Math.max(0, Math.floor(maxBytes));
	let bytes = 0;
	let overLimit = false;
	let pendingHighSurrogate = false;

	const markExceeded = (value: number = limit + 1) => {
		bytes = Math.max(value, limit + 1);
		overLimit = true;
		pendingHighSurrogate = false;
	};

	return {
		append(value: unknown) {
			if (overLimit) return;
			const text = asTokenText(value);
			if (!text) {
				if (pendingHighSurrogate) {
					pendingHighSurrogate = false;
					bytes += 3;
					if (bytes > limit) markExceeded(bytes);
				}
				return;
			}
			const firstNonASCII = firstNonASCIIIndex(text);
			if (firstNonASCII < 0 && !pendingHighSurrogate) {
				const nextBytes = bytes + text.length;
				if (nextBytes > limit) markExceeded(nextBytes);
				else bytes = nextBytes;
				return;
			}
			for (let i = 0; i < text.length; i++) {
				const code = text.charCodeAt(i);
				if (pendingHighSurrogate) {
					pendingHighSurrogate = false;
					if (code >= 0xdc00 && code <= 0xdfff) {
						bytes += 4;
						if (bytes > limit) {
							markExceeded(bytes);
							return;
						}
						continue;
					}
					bytes += 3;
					if (bytes > limit) {
						markExceeded(bytes);
						return;
					}
				}
				if (code <= 0x7f) {
					bytes += 1;
				} else if (code <= 0x7ff) {
					bytes += 2;
				} else if (code >= 0xd800 && code <= 0xdbff) {
					if (i + 1 < text.length) {
						const next = text.charCodeAt(i + 1);
						if (next >= 0xdc00 && next <= 0xdfff) {
							bytes += 4;
							i += 1;
						} else {
							bytes += 3;
						}
					} else {
						pendingHighSurrogate = true;
					}
				} else {
					bytes += 3;
				}
				if (bytes > limit) {
					markExceeded(bytes);
					return;
				}
			}
		},
		result() {
			if (!overLimit && pendingHighSurrogate) {
				pendingHighSurrogate = false;
				bytes += 3;
				if (bytes > limit) markExceeded(bytes);
			}
			return { bytes, exceeded: overLimit, exact: !overLimit, maxBytes: limit };
		},
		exceeded() {
			return overLimit;
		},
	};
}

export function codePointLengthAtLeast(text: unknown, min: number): boolean {
	const source = String(text || "");
	if (source.length < min) return false;
	let count = 0;
	for (let i = 0; i < source.length; i++) {
		count += 1;
		const code = source.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
			const next = source.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) i += 1;
		}
		if (count >= min) return true;
	}
	return false;
}

export function codePointLength(text: unknown): number {
	const source = String(text || "");
	let count = 0;
	for (let i = 0; i < source.length; i++) {
		count += 1;
		const code = source.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
			const next = source.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) i += 1;
		}
	}
	return count;
}

export function trimContinuationOverlap(
	existing: string,
	incoming: string,
): string {
	if (!incoming) return "";
	if (!existing) return incoming;
	if (incoming.startsWith(existing)) return incoming.slice(existing.length);
	if (existing.startsWith(incoming)) return "";
	return incoming;
}
