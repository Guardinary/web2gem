type MarkdownFenceLine = {
	ch: string;
	len: number;
	index: number;
	canClose: boolean;
};
type MarkdownFenceState = { ch: string; len: number; index: number };
type MarkdownRange = { start: number; end: number };
type MaskedMarkdown = { text: string; restore: (value: unknown) => string };
export type MarkdownProtectionLookup = {
	isProtected: (index: number) => boolean;
};

const MARKDOWN_FENCE_LINE_RE = /^(\s*)(```+|~~~+)([^\r\n]*)$/;

export function createMarkdownProtectionLookup(
	text: unknown,
): MarkdownProtectionLookup {
	const ranges = markdownProtectedRanges(text);
	return {
		isProtected(index: number): boolean {
			return isIndexInRanges(ranges, Math.max(0, index));
		},
	};
}

export function markdownProtectedSpanStartAtCut(
	text: unknown,
	cut: number,
): number {
	const source = String(text || "");
	const pos = Math.max(0, Math.min(source.length, cut));
	if (pos <= 0 || pos >= source.length) return -1;
	const fenceStart = openMarkdownFenceStart(source.slice(0, pos));
	if (fenceStart >= 0) return fenceStart;
	return markdownCodeSpanStartAt(source, pos);
}

function markdownCodeSpanStartAt(text: unknown, index: number): number {
	const source = String(text || "");
	const pos = Math.max(0, Math.min(source.length, index));
	const lineStart =
		Math.max(
			source.lastIndexOf("\n", pos - 1),
			source.lastIndexOf("\r", pos - 1),
		) + 1;
	let openIndex = -1;
	let openLen = 0;
	for (let i = lineStart; i < pos; i++) {
		if (source[i] !== "`") continue;
		let j = i;
		while (j < source.length && source[j] === "`") j++;
		const len = j - i;
		if (len < 3) {
			if (openIndex >= 0 && len === openLen) {
				openIndex = -1;
				openLen = 0;
			} else if (openIndex < 0) {
				openIndex = i;
				openLen = len;
			}
		}
		i = j - 1;
	}
	return openIndex;
}

export function markdownProtectedTailStart(text: unknown): number {
	const source = String(text || "");
	if (!source) return -1;
	const fenceStart = openMarkdownFenceStart(source);
	if (fenceStart >= 0) return fenceStart;
	return openMarkdownCodeSpanStart(source);
}

function openMarkdownFenceStart(text: unknown): number {
	const source = String(text || "");
	const state: { fence: MarkdownFenceState | null } = { fence: null };
	forEachMarkdownLine(source, (line, lineStart) => {
		const parsed = parseMarkdownFenceLine(line);
		if (parsed) {
			const cur = {
				ch: parsed.ch,
				len: parsed.len,
				index: lineStart + parsed.index,
			};
			if (!state.fence) state.fence = cur;
			else if (
				parsed.canClose &&
				cur.ch === state.fence.ch &&
				cur.len >= state.fence.len
			)
				state.fence = null;
		}
	});
	return state.fence ? state.fence.index : -1;
}

export function parseMarkdownFenceLine(
	line: unknown,
): MarkdownFenceLine | null {
	const m = MARKDOWN_FENCE_LINE_RE.exec(String(line || ""));
	if (!m) return null;
	const mark = m[2] || "";
	if (!mark) return null;
	const rest = String(m[3] || "");
	const trimmed = rest.trim();
	if (mark[0] === "`" && rest.includes("`")) return null;
	if (trimmed && /[<>\]]/.test(trimmed)) return null;
	if (trimmed && !/^[A-Za-z0-9_.+#-]+(?:[ \t].*)?$/.test(trimmed)) return null;
	return {
		ch: mark[0] || "",
		len: mark.length,
		index: (m[1] || "").length,
		canClose: !trimmed,
	};
}

function openMarkdownCodeSpanStart(text: unknown): number {
	const source = String(text || "");
	const lineStart =
		Math.max(source.lastIndexOf("\n"), source.lastIndexOf("\r")) + 1;
	let openIndex = -1;
	let openLen = 0;
	for (let i = lineStart; i < source.length; i++) {
		if (source[i] !== "`") continue;
		let j = i;
		while (j < source.length && source[j] === "`") j++;
		const len = j - i;
		if (len < 3) {
			if (openIndex >= 0 && len === openLen) {
				openIndex = -1;
				openLen = 0;
			} else if (openIndex < 0) {
				openIndex = i;
				openLen = len;
			}
		}
		i = j - 1;
	}
	return openIndex;
}

function markdownProtectedRanges(text: unknown): MarkdownRange[] {
	const source = String(text || "");
	const ranges: MarkdownRange[] = [];
	const state: { fence: MarkdownFenceState | null } = { fence: null };
	forEachMarkdownLine(source, (line, lineStart, separatorLength) => {
		const parsed = parseMarkdownFenceLine(line);
		if (state.fence) {
			if (
				parsed?.canClose &&
				parsed.ch === state.fence.ch &&
				parsed.len >= state.fence.len
			) {
				ranges.push({
					start: state.fence.index,
					end: lineStart + line.length + separatorLength,
				});
				state.fence = null;
			}
		} else if (parsed) {
			const cur = {
				ch: parsed.ch,
				len: parsed.len,
				index: lineStart + parsed.index,
			};
			state.fence = cur;
		} else {
			appendInlineCodeSpanRanges(line, lineStart, ranges);
		}
	});
	if (state.fence)
		ranges.push({ start: state.fence.index, end: source.length });

	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: MarkdownRange[] = [];
	for (const r of ranges) {
		if (r.start < 0 || r.end <= r.start) continue;
		const last = merged[merged.length - 1];
		if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
		else merged.push({ start: r.start, end: r.end });
	}
	return merged;
}

function forEachMarkdownLine(
	source: string,
	visit: (line: string, lineStart: number, separatorLength: number) => void,
): void {
	let lineStart = 0;
	for (;;) {
		const newline = source.indexOf("\n", lineStart);
		if (newline < 0) {
			visit(source.slice(lineStart), lineStart, 0);
			return;
		}
		const hasCarriageReturn =
			newline > lineStart && source.charCodeAt(newline - 1) === 13;
		const lineEnd = hasCarriageReturn ? newline - 1 : newline;
		visit(
			source.slice(lineStart, lineEnd),
			lineStart,
			hasCarriageReturn ? 2 : 1,
		);
		lineStart = newline + 1;
	}
}

function appendInlineCodeSpanRanges(
	line: string,
	lineStart: number,
	ranges: MarkdownRange[],
): void {
	let openIndex = -1;
	let openLen = 0;
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== "`") continue;
		let j = i;
		while (j < line.length && line[j] === "`") j++;
		const len = j - i;
		if (len < 3) {
			if (openIndex >= 0 && len === openLen) {
				ranges.push({ start: lineStart + openIndex, end: lineStart + j });
				openIndex = -1;
				openLen = 0;
			} else if (openIndex < 0) {
				openIndex = i;
				openLen = len;
			}
		}
		i = j - 1;
	}
	if (openIndex >= 0)
		ranges.push({ start: lineStart + openIndex, end: lineStart + line.length });
}

function isIndexInRanges(ranges: MarkdownRange[], index: number): boolean {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const range = ranges[mid];
		if (!range) return false;
		if (index < range.start) hi = mid - 1;
		else if (index >= range.end) lo = mid + 1;
		else return true;
	}
	return false;
}

export function maskMarkdownProtectedSpans(text: unknown): MaskedMarkdown {
	const source = String(text || "");
	const ranges = markdownProtectedRanges(source);
	const placeholders: [string, string][] = [];
	if (!ranges.length)
		return { text: source, restore: (value: unknown) => String(value || "") };
	let last = 0;
	let masked = "";
	for (let i = 0; i < ranges.length; i++) {
		const r = ranges[i];
		if (!r) continue;
		const token = `GEMINI_MD_PROTECTED_${i}_TOKEN`;
		placeholders.push([token, source.slice(r.start, r.end)]);
		masked += source.slice(last, r.start) + token;
		last = r.end;
	}
	masked += source.slice(last);
	const restoreByToken = new Map(placeholders);
	const restoreRe = new RegExp(
		placeholders.map(([token]) => escapeRegex(token)).join("|"),
		"g",
	);
	return {
		text: masked,
		restore(value: unknown) {
			return String(value || "").replace(
				restoreRe,
				(token) => restoreByToken.get(token) || token,
			);
		},
	};
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
