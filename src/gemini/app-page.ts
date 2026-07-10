export type GeminiAppPageTokens = { push_id?: string; at?: string };

type TextStreamResponse = {
	body?: ReadableStream<Uint8Array> | null;
	text: () => Promise<string>;
};
type QuotedMarkerSpec<K extends string> = { key: K; marker: string };

const APP_PAGE_TOKEN_MARKERS: QuotedMarkerSpec<keyof GeminiAppPageTokens>[] = [
	{ key: "push_id", marker: '"qKIAYe":"' },
	{ key: "at", marker: '"SNlM0e":"' },
];
const PUSH_ID_MARKER: QuotedMarkerSpec<"push_id"> = {
	key: "push_id",
	marker: '"qKIAYe":"',
};
const CFB2H_MARKER = '"cfb2h":"';
const BUILD_LABEL_PREFIX = "boq_assistant-bard-web-server_";
const BUILD_LABEL_KEEP_CHARS = BUILD_LABEL_PREFIX.length + 128;
const MAX_QUOTED_MARKER_VALUE_CHARS = 8 * 1024;

export async function extractGeminiAppPageTokens(
	resp: TextStreamResponse,
): Promise<GeminiAppPageTokens> {
	const scanner = createQuotedMarkerScanner(APP_PAGE_TOKEN_MARKERS);
	await scanResponseText(resp, (chunk) => {
		scanner.push(chunk);
		return scanner.done;
	});
	return scanner.result;
}

export async function extractGeminiPushId(
	resp: TextStreamResponse,
): Promise<string> {
	const scanner = createQuotedMarkerScanner([PUSH_ID_MARKER]);
	await scanResponseText(resp, (chunk) => {
		scanner.push(chunk);
		return scanner.done;
	});
	return scanner.result.push_id || "";
}

export async function extractGeminiBuildLabel(
	resp: TextStreamResponse,
): Promise<string> {
	const scanner = createBuildLabelScanner();
	await scanResponseText(resp, (chunk) => scanner.push(chunk));
	return scanner.label || scanner.finish();
}

async function scanResponseText(
	resp: TextStreamResponse,
	onChunk: (text: string) => boolean,
): Promise<void> {
	const body = resp.body;
	if (!body || typeof body.getReader !== "function") {
		onChunk(await resp.text());
		return;
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let shouldCancel = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.length) continue;
			const text = decoder.decode(value, { stream: true });
			if (text && onChunk(text)) {
				shouldCancel = true;
				break;
			}
		}
		if (!shouldCancel) {
			const tail = decoder.decode();
			if (tail) shouldCancel = onChunk(tail);
		}
		if (shouldCancel) await reader.cancel().catch(() => undefined);
	} finally {
		try {
			reader.releaseLock();
		} catch (_) {}
	}
}

function createQuotedMarkerScanner<K extends string>(
	specs: readonly QuotedMarkerSpec<K>[],
) {
	const result: Partial<Record<K, string>> = {};
	const found = new Set<K>();
	const keepChars = Math.max(0, ...specs.map((spec) => spec.marker.length - 1));
	let pending = "";
	let active: { key: K; value: string } | null = null;

	const push = (text: string): void => {
		pending += text;
		let pos = 0;
		for (;;) {
			if (active) {
				const end = pending.indexOf('"', pos);
				if (end < 0) {
					const nextValue = active.value + pending.slice(pos);
					if (nextValue.length > MAX_QUOTED_MARKER_VALUE_CHARS) {
						active = null;
						pending = pending.slice(Math.max(pos, pending.length - keepChars));
						return;
					}
					active.value = nextValue;
					pending = "";
					return;
				}
				const value = active.value + pending.slice(pos, end);
				if (value.length <= MAX_QUOTED_MARKER_VALUE_CHARS) {
					result[active.key] = value;
					found.add(active.key);
				}
				active = null;
				pos = end + 1;
				continue;
			}

			let bestIndex = -1;
			let bestSpec: QuotedMarkerSpec<K> | null = null;
			for (const spec of specs) {
				if (found.has(spec.key)) continue;
				const index = pending.indexOf(spec.marker, pos);
				if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
					bestIndex = index;
					bestSpec = spec;
				}
			}
			if (!bestSpec) {
				pending = pending.slice(Math.max(pos, pending.length - keepChars));
				return;
			}
			pos = bestIndex + bestSpec.marker.length;
			active = { key: bestSpec.key, value: "" };
		}
	};

	return {
		result: result as Partial<Record<K, string>>,
		push,
		get done() {
			return found.size >= specs.length;
		},
	};
}

function createBuildLabelScanner() {
	const quoted = createQuotedMarkerScanner([
		{ key: "label", marker: CFB2H_MARKER },
	]);
	let pending = "";
	let label = "";

	const scanPrefixLabel = (final: boolean): string => {
		const start = pending.indexOf(BUILD_LABEL_PREFIX);
		if (start < 0) {
			pending = pending.slice(-BUILD_LABEL_KEEP_CHARS);
			return "";
		}
		let end = start + BUILD_LABEL_PREFIX.length;
		while (end < pending.length && isBuildLabelChar(pending.charCodeAt(end)))
			end += 1;
		if (end === pending.length && !final) {
			pending = pending.slice(start);
			return "";
		}
		if (end > start + BUILD_LABEL_PREFIX.length)
			return pending.slice(start, end);
		pending = pending.slice(
			Math.max(start, pending.length - BUILD_LABEL_KEEP_CHARS),
		);
		return "";
	};

	return {
		get label() {
			return label;
		},
		push(text: string): boolean {
			quoted.push(text);
			const quotedLabel = quoted.result.label;
			if (quotedLabel) {
				label = quotedLabel;
				return true;
			}
			pending += text;
			label = scanPrefixLabel(false);
			return !!label;
		},
		finish(): string {
			if (label) return label;
			const quotedLabel = quoted.result.label;
			if (quotedLabel) return quotedLabel;
			return scanPrefixLabel(true);
		},
	};
}

function isBuildLabelChar(code: number): boolean {
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		code === 45 ||
		code === 46 ||
		code === 95
	);
}
