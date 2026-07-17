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

export function promptByteLength(value: unknown): number {
	const text = asText(value);
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
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

export function promptByteLengthBounded(
	value: unknown,
	maxBytes: number,
): PromptByteLengthBounded {
	const text = asText(value);
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
			} else bytes += 3;
		} else bytes += 3;
		if (bytes > limit)
			return { bytes, exceeded: true, exact: false, maxBytes: limit };
	}
	return { bytes, exceeded: false, exact: true, maxBytes: limit };
}

export function promptByteLengthGreaterThan(
	value: unknown,
	maxBytes: number,
): boolean {
	return promptByteLengthBounded(value, maxBytes).exceeded;
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
			const text = asText(value);
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
				if (code <= 0x7f) bytes += 1;
				else if (code <= 0x7ff) bytes += 2;
				else if (code >= 0xd800 && code <= 0xdbff) {
					if (i + 1 < text.length) {
						const next = text.charCodeAt(i + 1);
						if (next >= 0xdc00 && next <= 0xdfff) {
							bytes += 4;
							i += 1;
						} else bytes += 3;
					} else pendingHighSurrogate = true;
				} else bytes += 3;
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

function asText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return asText(value[0]);
	if (value == null) return "";
	return String(value);
}

function firstNonASCIIIndex(source: string): number {
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) > 0x7f) return i;
	}
	return -1;
}
