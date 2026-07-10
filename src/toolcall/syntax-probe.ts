import {
	createMarkdownProtectionLookup,
	type MarkdownProtectionLookup,
} from "./markdown";

export const TOOL_MARKUP_CONFUSABLE_RE =
	/[※＜〈＞〉／＝＂“”＇‘’｜！\u3000ｄＤｓＳЅｍＭΜｌＬοоаｅΑАС\u200b\ufeff]/;

const TOOL_TAG_RE =
	/<\s*\/?\s*(?:\|?\s*D?SML\s*[|!、\u0002␂_\-\s▁]+|D?SML(?=tool_calls|tool-calls|toolcalls|invoke|parameter)|[\w$-]+[|!、\u0002␂_\-\s▁💥]+)?\s*(tool_calls|tool-calls|toolcalls|invoke|parameter)\b/giu;
const TOOL_CAMEL_TAG_RE =
	/<\s*\/?\s*[A-Za-z][A-Za-z0-9_$-]*(ToolCalls|Invoke|Parameter)\b/g;
const TOOL_TAG_SHELL_QUICK_AT_OPEN_RE =
	/<\s*\/?\s*(?:\|?\s*D?SML\s*(?:[|!、\u0002␂_\-\s▁]+|(?=tool_calls|tool-calls|toolcalls|invoke|parameter))|tool_calls\b|tool-calls\b|toolcalls\b|invoke\b|parameter\b|[A-Za-z][A-Za-z0-9_$-]*(?:ToolCalls|Invoke|Parameter)\b|[\w$-]+(?:[|!、\u0002␂_\-▁💥]+|\s+)\s*(?:tool_calls|tool-calls|toolcalls|invoke|parameter)\b)/iuy;
const TOOL_CALLS_CLOSE_RE =
	/<\s*\/\s*(?:\|?\s*D?SML\s*[|!、\u0002␂_\-\s▁]+)?\s*(tool_calls|tool-calls|toolcalls)\s*>/i;
const PARTIAL_TOOL_PREFIXES = [
	"<|dsml|tool_calls",
	"<|dsml|tool-calls",
	"<|dsml|toolcalls",
	"<|dsml|invoke",
	"<|dsml|parameter",
	"<dsmltool_calls",
	"<dsmltool-calls",
	"<dsmltoolcalls",
	"<dsmlinvoke",
	"<dsmlparameter",
	"<tool_calls",
	"<tool-calls",
	"<toolcalls",
	"<invoke",
	"<parameter",
];

export function hasToolCallSyntaxCandidate(text: unknown): boolean {
	return hasToolCallMarkupSyntaxCandidate(text);
}

export function hasToolCallMarkupSyntaxCandidate(text: unknown): boolean {
	return containsToolMarkupSyntax(text);
}

export function containsToolMarkupSyntax(text: unknown): boolean {
	const source = normalizeToolMarkupConfusables(String(text || ""));
	if (!hasMarkupOpen(source)) return false;
	return hasToolTagShellAtMarkupOpen(source);
}

export function findToolCallSyntaxCandidateStart(
	text: unknown,
	ignoreMarkdown = true,
): number {
	const source = normalizeToolMarkupConfusables(String(text || ""));
	if (!hasMarkupOpen(source)) return -1;
	const markdown = ignoreMarkdown
		? createMarkdownProtectionLookup(source)
		: null;
	if (hasToolTagShellAtMarkupOpen(source)) {
		const fromTag = findRegexCandidateStart(source, TOOL_TAG_RE, markdown);
		if (fromTag >= 0) return fromTag;
		const fromCamel = findRegexCandidateStart(
			source,
			TOOL_CAMEL_TAG_RE,
			markdown,
		);
		if (fromCamel >= 0) return fromCamel;
	}
	return findLastPartialToolCallSyntaxPrefixInNormalizedSource(
		source,
		markdown,
	);
}

export function findLastPartialToolCallSyntaxPrefix(
	text: unknown,
	ignoreMarkdown = true,
): number {
	const source = normalizeToolMarkupConfusables(String(text || ""));
	if (source.lastIndexOf("<") < 0) return -1;
	return findLastPartialToolCallSyntaxPrefixInNormalizedSource(
		source,
		ignoreMarkdown ? createMarkdownProtectionLookup(source) : null,
	);
}

function findLastPartialToolCallSyntaxPrefixInNormalizedSource(
	source: string,
	markdown: MarkdownProtectionLookup | null,
): number {
	const lastLt = source.lastIndexOf("<");
	if (lastLt < 0) return -1;
	if (markdown?.isProtected(lastLt)) return -1;
	return isPartialToolCallSyntaxPrefix(source.slice(lastLt)) ? lastLt : -1;
}

export function isPartialToolCallSyntaxPrefix(text: unknown): boolean {
	const compact = normalizeMarkupTagShell(String(text || ""))
		.replace(/[\s▁]+/g, "")
		.toLowerCase();
	if (compact?.[0] !== "<") return false;
	return PARTIAL_TOOL_PREFIXES.some(
		(candidate) =>
			candidate.startsWith(compact) || compact.startsWith(candidate),
	);
}

export function hasClosedToolCallsSyntax(text: unknown): boolean {
	const source = normalizeToolMarkupConfusables(String(text || ""));
	return TOOL_CALLS_CLOSE_RE.test(source);
}

export function toolCallSieveSafeTailLength(text: unknown): number {
	const source = String(text || "");
	const partial = findLastPartialToolCallSyntaxPrefix(source);
	if (partial < 0) return 64;
	return Math.max(64, source.length - partial);
}

export function normalizeToolMarkupConfusables(text: unknown): string {
	const source = String(text || "");
	if (!TOOL_MARKUP_CONFUSABLE_RE.test(source)) return source;
	return source
		.replace(/※\s*>/g, ">")
		.replace(/[＜〈]/g, "<")
		.replace(/[＞〉]/g, ">")
		.replace(/[／]/g, "/")
		.replace(/[＝]/g, "=")
		.replace(/[＂“”]/g, '"')
		.replace(/[＇‘’]/g, "'")
		.replace(/[｜]/g, "|")
		.replace(/[！]/g, "!")
		.replace(/[、]/g, "、")
		.replace(/[\u3000]/g, " ")
		.replace(/[ｄＤ]/g, "D")
		.replace(/[ｓＳЅ]/g, "S")
		.replace(/[ｍＭΜ]/g, "M")
		.replace(/[ｌＬ]/g, "L")
		.replace(/[οо]/g, "o")
		.replace(/[а]/g, "a")
		.replace(/[е]/g, "e")
		.replace(/[ΑА]/g, "A")
		.replace(/[С]/g, "C")
		.replace(/※/g, ">")
		.replace(/[\u200b\ufeff]/g, "");
}

export function normalizeMarkupTagShell(tag: unknown): string {
	return normalizeToolMarkupConfusables(tag);
}

function findRegexCandidateStart(
	source: string,
	re: RegExp,
	markdown: MarkdownProtectionLookup | null,
): number {
	re.lastIndex = 0;
	let m: RegExpExecArray | null = re.exec(source);
	while (m !== null) {
		if (!markdown?.isProtected(m.index)) return m.index;
		re.lastIndex = m.index + Math.max(1, m[0].length);
		m = re.exec(source);
	}
	return -1;
}

function hasMarkupOpen(source: string): boolean {
	return (
		source.indexOf("<") >= 0 ||
		source.indexOf("＜") >= 0 ||
		source.indexOf("〈") >= 0
	);
}

function hasToolTagShellAtMarkupOpen(source: string): boolean {
	let index = source.indexOf("<");
	while (index >= 0) {
		TOOL_TAG_SHELL_QUICK_AT_OPEN_RE.lastIndex = index;
		if (TOOL_TAG_SHELL_QUICK_AT_OPEN_RE.test(source)) return true;
		index = source.indexOf("<", index + 1);
	}
	return false;
}
