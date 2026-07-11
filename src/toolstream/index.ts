import {
	findToolSieveCandidateStart,
	isPartialToolMarkupPrefix,
	parseDSMLToolCallsDetailed,
	toolSieveSafeTailLength,
} from "../toolcall/dsml";
import {
	markdownProtectedSpanStartAtCut,
	markdownProtectedTailStart,
} from "../toolcall/markdown";
import { hasClosedToolCallsSyntax } from "../toolcall/syntax-probe";
import {
	formatOpenAIToolCalls,
	type OpenAIToolCall,
} from "../toolcall/openai-format";

export type ToolSieveState = {
	buffer: string;
	holdingToolCandidate: boolean;
	sawToolClose: boolean;
	parsedToolCandidate: boolean;
	candidateStart: number;
	confirmedToolCandidate: boolean;
	heldChunks?: string[];
	heldLength?: number;
	heldTail?: string;
	parsedToolCandidateResult?: ReturnType<
		typeof parseDSMLToolCallsDetailed
	> | null;
	parsedToolCandidateLength?: number;
};

export type ToolSieveFlushResult = {
	text: string;
	toolCalls: OpenAIToolCall[] | null;
};

export function createToolSieveState(): ToolSieveState {
	return {
		buffer: "",
		holdingToolCandidate: false,
		sawToolClose: false,
		parsedToolCandidate: false,
		candidateStart: -1,
		confirmedToolCandidate: false,
		heldChunks: [],
		heldLength: 0,
		heldTail: "",
		parsedToolCandidateResult: null,
		parsedToolCandidateLength: 0,
	};
}

export const TOOL_SIEVE_PLAIN_TEXT_KEEP = 64;
export const TOOL_SIEVE_MAX_CANDIDATE_CHARS = 256 * 1024;
const COMPLETE_TOOL_CANDIDATE_OPEN_RE =
	/^\s*<\s*(?:\|DSML\|)?(?:tool_calls|tool-calls|toolcalls|invoke|parameter)\b[^>]*>/i;

export function hasToolSieveSentinel(text: unknown): boolean {
	return findToolSieveCandidateStart(text) >= 0;
}

export function flushToolSievePlainPrefix(
	state: ToolSieveState | null | undefined,
): string[] | null {
	if (
		!state ||
		state.holdingToolCandidate ||
		hasToolSieveSentinel(state.buffer)
	)
		return null;
	if (state.buffer.length <= TOOL_SIEVE_PLAIN_TEXT_KEEP) return null;
	const emitLen = state.buffer.length - TOOL_SIEVE_PLAIN_TEXT_KEEP;
	const out = state.buffer.slice(0, emitLen);
	state.buffer = state.buffer.slice(emitLen);
	return out ? [out] : null;
}

export function hasToolCallCloseSyntax(text: unknown): boolean {
	return hasClosedToolCallsSyntax(text);
}

export function processToolSieveChunk(
	state: ToolSieveState | null | undefined,
	chunk: unknown,
): string[] {
	const activeState = state || createToolSieveState();
	ensureToolSieveStateShape(activeState);
	const incoming = String(chunk || "");
	if (activeState.holdingToolCandidate) {
		const tail =
			activeState.heldTail ||
			(activeState.buffer ? activeState.buffer.slice(-128) : "");
		appendHeldChunk(activeState, incoming);
		if (hasToolCallCloseSyntax(tail + incoming))
			activeState.sawToolClose = true;
		return processHeldToolCandidate(activeState);
	}
	activeState.buffer += incoming;
	if (!activeState.buffer) return [];

	const plainPrefix = flushToolSievePlainPrefix(activeState);
	if (plainPrefix) return plainPrefix;

	const start = findToolSieveCandidateStart(activeState.buffer);
	if (start >= 0) {
		activeState.holdingToolCandidate = true;
		activeState.sawToolClose = hasToolCallCloseSyntax(
			activeState.buffer.slice(start),
		);
		activeState.parsedToolCandidate = false;
		activeState.candidateStart = 0;
		const candidate = activeState.buffer.slice(start);
		activeState.confirmedToolCandidate =
			hasCompleteToolCandidateOpenPrefix(candidate);
		setHeldText(activeState, candidate);
		if (start === 0) return [];
		const out = activeState.buffer.slice(0, start);
		activeState.buffer = candidate;
		return out ? [out] : [];
	}

	const protectedTail = markdownProtectedTailStart(activeState.buffer);
	if (protectedTail >= 0) {
		if (protectedTail === 0) return [];
		const out = activeState.buffer.slice(0, protectedTail);
		activeState.buffer = activeState.buffer.slice(protectedTail);
		return out ? [out] : [];
	}

	const keep = toolSieveSafeTailLength(activeState.buffer);
	if (activeState.buffer.length <= keep) return [];
	let emitLen = activeState.buffer.length - keep;
	const protectedStart = markdownProtectedSpanStartAtCut(
		activeState.buffer,
		emitLen,
	);
	if (protectedStart >= 0) emitLen = protectedStart;
	if (emitLen <= 0) return [];
	const out = activeState.buffer.slice(0, emitLen);
	activeState.buffer = activeState.buffer.slice(emitLen);
	return out ? [out] : [];
}

function processHeldToolCandidate(state: ToolSieveState): string[] {
	if (state.parsedToolCandidate) return [];
	if (!state.confirmedToolCandidate) {
		const prefix = heldPrefixText(state, 512);
		if (isPartialToolMarkupPrefix(prefix)) {
			if (heldLength(state) <= TOOL_SIEVE_MAX_CANDIDATE_CHARS) return [];
			const out = releaseHeldText(state);
			resetToolCandidateState(state);
			return out ? [out] : [];
		}
		if (
			state.sawToolClose &&
			heldLength(state) <= prefix.length &&
			/^\s*<\s*\/\s*(?:\|DSML\|)?tool_calls\s*>\s*$/i.test(prefix)
		)
			return [];
		state.confirmedToolCandidate = findToolSieveCandidateStart(prefix) === 0;
		if (state.confirmedToolCandidate) {
			if (!state.sawToolClose) return [];
		} else {
			const out = releaseHeldText(state);
			resetToolCandidateState(state);
			return out ? [out] : [];
		}
	}
	if (!state.sawToolClose) {
		if (heldLength(state) <= TOOL_SIEVE_MAX_CANDIDATE_CHARS) return [];
		const out = releaseHeldText(state);
		resetToolCandidateState(state);
		return out ? [out] : [];
	}

	const text = heldText(state);
	if (!state.confirmedToolCandidate) {
		if (
			state.sawToolClose &&
			/^\s*<\s*\/\s*(?:\|DSML\|)?tool_calls\s*>\s*$/i.test(text)
		)
			return [];
		state.confirmedToolCandidate = findToolSieveCandidateStart(text) === 0;
		if (!state.confirmedToolCandidate) {
			const out = releaseHeldText(state);
			resetToolCandidateState(state);
			return out ? [out] : [];
		}
	}
	if (/^\s*<\s*\/\s*(?:\|DSML\|)?tool_calls\s*>\s*$/i.test(text)) return [];
	const parsed = parseDSMLToolCallsDetailed(text);
	if (parsed.calls.length) {
		state.parsedToolCandidate = true;
		state.parsedToolCandidateResult = parsed;
		state.parsedToolCandidateLength = heldLength(state);
		return [];
	}
	if (parsed.sawToolCallSyntax) {
		if (hasCompleteToolCandidateOpenPrefix(text)) return [];
		const out = releaseHeldText(state);
		resetToolCandidateState(state);
		return out ? [out] : [];
	}
	state.buffer = releaseHeldText(state);
	resetToolCandidateFlags(state);
	return processToolSieveChunk(state, "");
}

function resetToolCandidateState(state: ToolSieveState): void {
	state.buffer = "";
	clearHeldText(state);
	resetToolCandidateFlags(state);
}

function resetToolCandidateFlags(state: ToolSieveState): void {
	state.holdingToolCandidate = false;
	state.sawToolClose = false;
	state.parsedToolCandidate = false;
	state.candidateStart = -1;
	state.confirmedToolCandidate = false;
	state.parsedToolCandidateResult = null;
	state.parsedToolCandidateLength = 0;
}

function ensureToolSieveStateShape(state: ToolSieveState): void {
	if (!Number.isInteger(state.candidateStart))
		state.candidateStart = state.holdingToolCandidate ? 0 : -1;
	if (!Array.isArray(state.heldChunks)) state.heldChunks = [];
	if (!Number.isFinite(state.heldLength || 0)) state.heldLength = 0;
	if (typeof state.heldTail !== "string") state.heldTail = "";
	if (state.holdingToolCandidate && !state.heldChunks.length && state.buffer)
		setHeldText(state, state.buffer);
	if (typeof state.confirmedToolCandidate !== "boolean") {
		const text = heldText(state);
		const start = findToolSieveCandidateStart(text);
		state.confirmedToolCandidate =
			state.holdingToolCandidate &&
			((state.sawToolClose && start < 0) ||
				(start === 0 && hasCompleteToolCandidateOpenPrefix(text)));
	}
}

function hasCompleteToolCandidateOpenPrefix(text: unknown): boolean {
	return COMPLETE_TOOL_CANDIDATE_OPEN_RE.test(String(text || ""));
}

function setHeldText(state: ToolSieveState, text: string): void {
	state.heldChunks = text ? [text] : [];
	state.heldLength = text.length;
	state.heldTail = text.slice(-128);
}

function appendHeldChunk(state: ToolSieveState, text: string): void {
	if (!text) return;
	if (!Array.isArray(state.heldChunks)) state.heldChunks = [];
	state.heldChunks.push(text);
	state.heldLength = (state.heldLength || 0) + text.length;
	state.heldTail =
		text.length >= 128
			? text.slice(-128)
			: `${state.heldTail || ""}${text}`.slice(-128);
}

function heldLength(state: ToolSieveState): number {
	return state.heldLength || state.buffer.length;
}

function heldText(state: ToolSieveState): string {
	const chunks = state.heldChunks || [];
	if (!chunks.length) return state.buffer;
	if (chunks.length === 1) return chunks[0] || "";
	const text = chunks.join("");
	setHeldText(state, text);
	state.buffer = text;
	return text;
}

function heldPrefixText(state: ToolSieveState, maxLength: number): string {
	const chunks = state.heldChunks || [];
	if (!chunks.length) return state.buffer.slice(0, maxLength);
	let out = "";
	for (const chunk of chunks) {
		if (out.length + chunk.length >= maxLength)
			return out + chunk.slice(0, maxLength - out.length);
		out += chunk;
	}
	return out;
}

function releaseHeldText(state: ToolSieveState): string {
	const text = heldText(state);
	clearHeldText(state);
	return text;
}

function clearHeldText(state: ToolSieveState): void {
	state.heldChunks = [];
	state.heldLength = 0;
	state.heldTail = "";
}

export function flushToolSieve(
	state: ToolSieveState | null | undefined,
	toolsRaw: unknown,
): ToolSieveFlushResult {
	if (state) ensureToolSieveStateShape(state);
	const buffered = state ? heldText(state) : "";
	if (!buffered) return { text: "", toolCalls: null };
	if (findToolSieveCandidateStart(buffered) < 0)
		return { text: buffered, toolCalls: null };
	const parsed =
		state?.parsedToolCandidateResult &&
		state.parsedToolCandidateLength === buffered.length
			? state.parsedToolCandidateResult
			: parseDSMLToolCallsDetailed(buffered);
	if (!parsed.calls.length)
		return { text: String(buffered || "").trim(), toolCalls: null };
	const toolCalls = formatOpenAIToolCalls(parsed.calls, toolsRaw);
	return {
		text: parsed.cleanText,
		toolCalls: toolCalls.length ? toolCalls : null,
	};
}

export function toolSieveBufferedText(
	state: ToolSieveState | null | undefined,
): string {
	if (!state) return "";
	ensureToolSieveStateShape(state);
	return heldText(state);
}
