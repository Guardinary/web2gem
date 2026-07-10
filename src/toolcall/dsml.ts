import { isRecord, type UnknownRecord } from "../shared/types";
import { maskMarkdownProtectedSpans, parseMarkdownFenceLine } from "./markdown";
import { formatOpenAIToolCalls } from "./openai-format";
import {
	TOOL_MARKUP_CONFUSABLE_RE as TOOL_MARKUP_CONFUSABLE_RE_INTERNAL,
	containsToolMarkupSyntax as containsToolMarkupSyntaxCandidate,
	findToolCallSyntaxCandidateStart,
	hasToolCallMarkupSyntaxCandidate,
	hasToolCallSyntaxCandidate,
	isPartialToolCallSyntaxPrefix,
	normalizeMarkupTagShell as normalizeMarkupTagShellInternal,
	normalizeToolMarkupConfusables as normalizeToolMarkupConfusablesInternal,
	toolCallSieveSafeTailLength,
} from "./syntax-probe";
import {
	appendMarkupValue,
	decodeCDATA,
	decodeXmlEntities,
	findXmlElementBlocks,
	findTopLevelXmlElementBlocks,
	parseTagAttributes,
} from "./xml";
import type { OpenAIToolCall } from "./openai-format";
import type { XmlElementBlock } from "./xml";

type ParsedToolCall = {
	name: string;
	input: unknown;
};

type DSMLToolCallParseResult = {
	cleanText: string;
	calls: ParsedToolCall[];
	sawToolCallSyntax: boolean;
};

type MarkdownRestore = (value: unknown) => string;

export function parseToolCalls(
	text: unknown,
	toolsRaw: unknown,
): [string, OpenAIToolCall[]] {
	if (!mayContainToolCallSyntax(text)) return [String(text || "").trim(), []];
	const parsed = parseDSMLToolCallsDetailed(text);
	if (parsed.calls.length) {
		return [parsed.cleanText, formatOpenAIToolCalls(parsed.calls, toolsRaw)];
	}
	return [String(text || "").trim(), []];
}

export function mayContainToolCallSyntax(text: unknown): boolean {
	return hasToolCallSyntaxCandidate(text);
}

export function mayContainToolMarkupSyntax(text: unknown): boolean {
	return hasToolCallMarkupSyntaxCandidate(text);
}

export function findToolSieveCandidateStart(text: unknown): number {
	return findToolCallSyntaxCandidateStart(text);
}

export function isPartialToolMarkupPrefix(text: unknown): boolean {
	return isPartialToolCallSyntaxPrefix(text);
}

export function toolSieveSafeTailLength(text: unknown): number {
	return toolCallSieveSafeTailLength(text);
}

export function parseDSMLToolCallsDetailed(
	text: unknown,
): DSMLToolCallParseResult {
	const raw = String(text || "");
	if (!raw) return { cleanText: "", calls: [], sawToolCallSyntax: false };
	if (!mayContainToolMarkupSyntax(raw))
		return { cleanText: raw.trim(), calls: [], sawToolCallSyntax: false };
	if (containsToolMarkupSyntax(raw) && findToolSieveCandidateStart(raw) < 0) {
		return { cleanText: raw.trim(), calls: [], sawToolCallSyntax: true };
	}
	const canonical = parseCanonicalDSMLToolCallsFast(raw);
	if (canonical) return canonical;
	if (shouldSkipToolCallParsingForCodeFenceExample(raw))
		return { cleanText: raw.trim(), calls: [], sawToolCallSyntax: true };
	const protectedMarkdown = maskMarkdownProtectedSpans(raw);
	let normalized = normalizeDSMLToolCallMarkup(protectedMarkdown.text).trim();
	let blocks = findXmlElementBlocks(normalized, "tool_calls");
	if (
		!blocks.length &&
		/<\s*(?:\|DSML\|)?invoke\b/i.test(normalized) &&
		/<\s*\/\s*(?:\|DSML\|)?tool_calls\s*>/i.test(normalized)
	) {
		normalized = `<tool_calls>${normalized}`;
		blocks = findXmlElementBlocks(normalized, "tool_calls");
	}
	const calls: ParsedToolCall[] = [];
	for (const block of blocks) {
		for (const invoke of findXmlElementBlocks(block.body, "invoke")) {
			const parsed = parseMarkupSingleToolCall(invoke);
			if (parsed) calls.push(parsed);
		}
	}
	if (!calls.length) {
		return {
			cleanText: raw.trim(),
			calls: [],
			sawToolCallSyntax: containsToolMarkupSyntax(raw),
		};
	}
	let clean = normalized;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		if (block) clean = clean.slice(0, block.start) + clean.slice(block.end);
	}
	return {
		cleanText: protectedMarkdown.restore(clean).trim(),
		calls: restoreToolCallProtectedMarkdown(calls, protectedMarkdown.restore),
		sawToolCallSyntax: true,
	};
}

export function parseCanonicalDSMLToolCallsFast(
	text: unknown,
): DSMLToolCallParseResult | null {
	const source = String(text || "").trim();
	if (!source) return null;
	if (
		source.indexOf("`") >= 0 ||
		TOOL_MARKUP_CONFUSABLE_RE_INTERNAL.test(source)
	)
		return null;
	if (
		/<\s*\/?\s*(?:\|?\s*D?SML|tool-calls|toolcalls|[A-Za-z][A-Za-z0-9_$-]*(?:ToolCalls|Invoke|Parameter))\b/.test(
			source,
		)
	) {
		return null;
	}
	if (!/^<tool_calls(?:\s[^>]*)?>/i.test(source)) return null;
	const blocks = findXmlElementBlocks(source, "tool_calls");
	if (!blocks.length) return null;

	let pos = 0;
	for (const block of blocks) {
		if (source.slice(pos, block.start).trim()) return null;
		pos = block.end;
	}
	if (source.slice(pos).trim()) return null;

	const calls: ParsedToolCall[] = [];
	for (const block of blocks) {
		for (const invoke of findXmlElementBlocks(block.body, "invoke")) {
			const parsed = parseMarkupSingleToolCall(invoke);
			if (parsed) calls.push(parsed);
		}
	}
	if (!calls.length) return null;
	return { cleanText: "", calls, sawToolCallSyntax: true };
}

export function restoreToolCallProtectedMarkdown(
	calls: ParsedToolCall[],
	restore: MarkdownRestore,
): ParsedToolCall[] {
	if (!Array.isArray(calls) || typeof restore !== "function") return [];
	return calls.map((call) => {
		return {
			...call,
			input: restoreToolValueProtectedMarkdown(call.input, restore),
		};
	});
}

export function restoreToolValueProtectedMarkdown(
	value: unknown,
	restore: MarkdownRestore,
): unknown {
	if (typeof value === "string") {
		const restored = restore(value);
		return restored === value ? value : unwrapToolArgumentMarkdown(restored);
	}
	if (Array.isArray(value))
		return value.map((item) =>
			restoreToolValueProtectedMarkdown(item, restore),
		);
	if (isRecord(value)) {
		const out: UnknownRecord = {};
		for (const [key, child] of Object.entries(value))
			out[key] = restoreToolValueProtectedMarkdown(child, restore);
		return out;
	}
	return value;
}

export function unwrapToolArgumentMarkdown(value: unknown): string {
	const text = String(value || "");
	const trimmed = text.trim();
	const fence = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(
		trimmed,
	);
	if (fence) return fence[1] || "";
	const inline = /^`([^`\r\n]*)`$/.exec(trimmed);
	if (inline) return inline[1] || "";
	return text;
}

export function stripFencedCodeBlocks(text: unknown): string {
	const lines = String(text || "").split("\n");
	const out: string[] = [];
	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;
	for (const line of lines) {
		const parsed = parseMarkdownFenceLine(line);
		if (!inFence) {
			if (parsed) {
				inFence = true;
				fenceChar = parsed.ch;
				fenceLen = parsed.len;
				continue;
			}
			out.push(line);
			continue;
		}
		if (parsed?.canClose && parsed.ch === fenceChar && parsed.len >= fenceLen) {
			inFence = false;
			fenceChar = "";
			fenceLen = 0;
		}
	}
	return out.join("\n");
}

export function shouldSkipToolCallParsingForCodeFenceExample(
	text: unknown,
): boolean {
	if (!containsToolMarkupSyntax(text)) return false;
	return !containsToolMarkupSyntax(stripFencedCodeBlocks(text));
}

export function containsToolMarkupSyntax(text: unknown): boolean {
	return containsToolMarkupSyntaxCandidate(text);
}

export { TOOL_MARKUP_CONFUSABLE_RE } from "./syntax-probe";

export function normalizeToolMarkupConfusables(text: unknown): string {
	return normalizeToolMarkupConfusablesInternal(text);
}

export function normalizeMarkupTagShell(tag: unknown): string {
	return normalizeMarkupTagShellInternal(tag);
}

export function normalizeDSMLToolCallMarkup(text: unknown): string {
	return normalizeToolMarkupConfusables(text)
		.replace(/<<+/g, "<")
		.replace(/<!\s*\[\s*CDATA\s*\[/gi, "<![CDATA[")
		.replace(/<\s*[!、]\s*\[\s*CDATA\s*\[/gi, "<![CDATA[")
		.replace(/\]\]\s*>/g, "]]>")
		.replace(
			/<\s*(\/?)\s*(?:(?:\|?\s*D?SML\s*[|!、\u0002␂_\-\s▁]+)+(?:D?SML\s*[|!、\u0002␂_\-\s▁]+)*|D?SML(?=tool_calls|tool-calls|toolcalls|invoke|parameter)|[\w$-]+[|!、\u0002␂_\-\s▁💥]+)?\s*(tool_calls|tool-calls|toolcalls|invoke|parameter)\b([^>]*)>/giu,
			(_m: string, close: string, name: string, rest: string) =>
				`<${close ? "/" : ""}${canonicalToolTagName(name)}${rest}>`,
		)
		.replace(
			/<\s*(\/?)\s*[A-Za-z][A-Za-z0-9_$-]*(ToolCalls|Invoke|Parameter)\b([^>]*)>/g,
			(_m: string, close: string, name: string, rest: string) =>
				`<${close ? "/" : ""}${canonicalToolTagName(name)}${rest}>`,
		)
		.replace(
			/<\s*(\/?)\s*(tool-calls|toolcalls)\b([^>]*)>/gi,
			(_m: string, close: string, _name: string, rest: string) =>
				`<${close ? "/" : ""}tool_calls${rest}>`,
		);
}

export function canonicalToolTagName(name: unknown): string {
	const n = String(name || "").toLowerCase();
	return n === "tool-calls" || n === "toolcalls" ? "tool_calls" : n;
}

export function parseMarkupSingleToolCall(
	block: XmlElementBlock,
): ParsedToolCall | null {
	const attrs = parseTagAttributes(block.attrs);
	const name = String(attrs.name || "").trim();
	if (!name) return null;
	const inner = String(block.body || "").trim();
	if (inner) {
		try {
			const decoded: unknown = JSON.parse(inner);
			if (isRecord(decoded)) {
				const input =
					decoded.input ??
					decoded.parameters ??
					decoded.arguments ??
					decoded.args;
				return { name, input: isRecord(input) ? input : {} };
			}
		} catch (_) {}
	}
	const input: UnknownRecord = {};
	for (const match of findXmlElementBlocks(inner, "parameter")) {
		const parameterAttrs = parseTagAttributes(match.attrs);
		const paramName = String(parameterAttrs.name || "").trim();
		if (!paramName) continue;
		appendMarkupValue(input, paramName, parseMarkupValue(match.body));
	}
	if (!Object.keys(input).length && inner.trim() !== "") return null;
	return { name, input };
}

export function parseMarkupValue(body: unknown): unknown {
	const rawBody = String(body || "");
	const raw = rawBody.trim();
	if (!raw) return "";
	if (raw.startsWith("<![CDATA[")) return decodeCDATA(raw);
	const children = findTopLevelXmlElementBlocks(raw);
	if (children.length) {
		if (children.every((child) => child.name === "item"))
			return children.map((child) => parseMarkupValue(child.body));
		const obj: UnknownRecord = {};
		for (const child of children)
			appendMarkupValue(obj, child.name, parseMarkupValue(child.body));
		return obj;
	}
	const decoded = decodeCDATA(raw).trim();
	const decodedForMarkup = decoded.replace(/<br\s*\/?\s*>/gi, "\n").trim();
	const decodedChildren = findTopLevelXmlElementBlocks(decodedForMarkup);
	if (decodedChildren.length) {
		if (decodedChildren.every((child) => child.name === "item"))
			return decodedChildren.map((child) => parseMarkupValue(child.body));
		const obj: UnknownRecord = {};
		for (const child of decodedChildren)
			appendMarkupValue(obj, child.name, parseMarkupValue(child.body));
		return obj;
	}
	return parseScalarValue(decoded);
}

export function parseScalarValue(text: unknown): unknown {
	const s = String(text || "").trim();
	if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
	if (/^null$/i.test(s)) return null;
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) {
		const n = Number(s);
		if (Number.isFinite(n)) return n;
	}
	if (
		(s.startsWith("{") && s.endsWith("}")) ||
		(s.startsWith("[") && s.endsWith("]"))
	) {
		try {
			return JSON.parse(s);
		} catch (_) {}
	}
	if (s.startsWith("{") && /}\s*,\s*{/.test(s) && s.endsWith("}")) {
		try {
			return JSON.parse(`[${s}]`);
		} catch (_) {}
	}
	return decodeXmlEntities(s);
}
