import {
  findToolSieveCandidateStart,
  isPartialToolMarkupPrefix,
  parseDSMLToolCallsDetailed,
  parseToolCalls,
  toolSieveSafeTailLength,
} from "../toolcall/dsml";
import { markdownProtectedSpanStartAtCut, markdownProtectedTailStart } from "../toolcall/markdown";
import { hasClosedToolCallsSyntax } from "../toolcall/syntax-probe";
import type { OpenAIToolCall } from "../toolcall/openai-format";

export type ToolSieveState = {
  buffer: string;
  holdingToolCandidate: boolean;
  sawToolClose: boolean;
  parsedToolCandidate: boolean;
  candidateStart: number;
  confirmedToolCandidate: boolean;
};

export type ToolSieveFlushResult = {
  text: string;
  toolCalls: OpenAIToolCall[] | null;
};

export function createToolSieveState(): ToolSieveState {
  return { buffer: "", holdingToolCandidate: false, sawToolClose: false, parsedToolCandidate: false, candidateStart: -1, confirmedToolCandidate: false };
}

export const TOOL_SIEVE_PLAIN_TEXT_KEEP = 64;
export const TOOL_SIEVE_MAX_CANDIDATE_CHARS = 256 * 1024;
const COMPLETE_TOOL_CANDIDATE_OPEN_RE = /^\s*<\s*(?:\|DSML\|)?(?:tool_calls|tool-calls|toolcalls|invoke|parameter)\b[^>]*>/i;

export function hasToolSieveSentinel(text: unknown): boolean {
  return findToolSieveCandidateStart(text) >= 0;
}

export function flushToolSievePlainPrefix(state: ToolSieveState | null | undefined): string[] | null {
  if (!state || state.holdingToolCandidate || hasToolSieveSentinel(state.buffer)) return null;
  if (state.buffer.length <= TOOL_SIEVE_PLAIN_TEXT_KEEP) return null;
  const emitLen = state.buffer.length - TOOL_SIEVE_PLAIN_TEXT_KEEP;
  const out = state.buffer.slice(0, emitLen);
  state.buffer = state.buffer.slice(emitLen);
  return out ? [out] : null;
}

export function hasToolCallCloseSyntax(text: unknown): boolean {
  return hasClosedToolCallsSyntax(text);
}

export function processToolSieveChunk(state: ToolSieveState | null | undefined, chunk: unknown): string[] {
  if (!state) state = createToolSieveState();
  ensureToolSieveStateShape(state);
  const incoming = String(chunk || "");
  const tail = state.buffer ? state.buffer.slice(-128) : "";
  state.buffer += incoming;
  if (state.holdingToolCandidate && hasToolCallCloseSyntax(tail + incoming)) state.sawToolClose = true;
  if (!state.buffer) return [];

  if (state.holdingToolCandidate) return processHeldToolCandidate(state);

  const plainPrefix = flushToolSievePlainPrefix(state);
  if (plainPrefix) return plainPrefix;

  const start = findToolSieveCandidateStart(state.buffer);
  if (start >= 0) {
    state.holdingToolCandidate = true;
    state.sawToolClose = hasToolCallCloseSyntax(state.buffer.slice(start));
    state.parsedToolCandidate = false;
    state.candidateStart = 0;
    state.confirmedToolCandidate = hasCompleteToolCandidateOpenPrefix(state.buffer.slice(start));
    if (start === 0) return [];
    const out = state.buffer.slice(0, start);
    state.buffer = state.buffer.slice(start);
    return out ? [out] : [];
  }

  const protectedTail = markdownProtectedTailStart(state.buffer);
  if (protectedTail >= 0) {
    if (protectedTail === 0) return [];
    const out = state.buffer.slice(0, protectedTail);
    state.buffer = state.buffer.slice(protectedTail);
    return out ? [out] : [];
  }

  const keep = toolSieveSafeTailLength(state.buffer);
  if (state.buffer.length <= keep) return [];
  let emitLen = state.buffer.length - keep;
  const protectedStart = markdownProtectedSpanStartAtCut(state.buffer, emitLen);
  if (protectedStart >= 0) emitLen = protectedStart;
  if (emitLen <= 0) return [];
  const out = state.buffer.slice(0, emitLen);
  state.buffer = state.buffer.slice(emitLen);
  return out ? [out] : [];
}

function processHeldToolCandidate(state: ToolSieveState): string[] {
  if (!state.confirmedToolCandidate && isPartialToolMarkupPrefix(state.buffer)) return [];
  if (state.parsedToolCandidate) return [];
  if (!state.confirmedToolCandidate) {
    if (state.sawToolClose && /^\s*<\s*\/\s*(?:\|DSML\|)?tool_calls\s*>\s*$/i.test(state.buffer)) return [];
    state.confirmedToolCandidate = findToolSieveCandidateStart(state.buffer) === 0;
    if (!state.confirmedToolCandidate) {
      const out = state.buffer;
      resetToolCandidateState(state);
      return out ? [out] : [];
    }
  }
  if (!state.sawToolClose) {
    if (state.buffer.length <= TOOL_SIEVE_MAX_CANDIDATE_CHARS) return [];
    const out = state.buffer;
    resetToolCandidateState(state);
    return out ? [out] : [];
  }
  if (/^\s*<\s*\/\s*(?:\|DSML\|)?tool_calls\s*>\s*$/i.test(state.buffer)) return [];
  const parsed = parseDSMLToolCallsDetailed(state.buffer);
  if (parsed.calls.length) {
    state.parsedToolCandidate = true;
    return [];
  }
  if (parsed.sawToolCallSyntax) {
    if (hasCompleteToolCandidateOpenPrefix(state.buffer)) return [];
    const out = state.buffer;
    resetToolCandidateState(state);
    return out ? [out] : [];
  }
  resetToolCandidateFlags(state);
  return processToolSieveChunk(state, "");
}

function resetToolCandidateState(state: ToolSieveState): void {
  state.buffer = "";
  resetToolCandidateFlags(state);
}

function resetToolCandidateFlags(state: ToolSieveState): void {
  state.holdingToolCandidate = false;
  state.sawToolClose = false;
  state.parsedToolCandidate = false;
  state.candidateStart = -1;
  state.confirmedToolCandidate = false;
}

function ensureToolSieveStateShape(state: ToolSieveState): void {
  if (!Number.isInteger(state.candidateStart)) state.candidateStart = state.holdingToolCandidate ? 0 : -1;
  if (typeof state.confirmedToolCandidate !== "boolean") {
    const start = findToolSieveCandidateStart(state.buffer);
    state.confirmedToolCandidate = state.holdingToolCandidate
      && ((state.sawToolClose && start < 0) || (start === 0 && hasCompleteToolCandidateOpenPrefix(state.buffer)));
  }
}

function hasCompleteToolCandidateOpenPrefix(text: unknown): boolean {
  return COMPLETE_TOOL_CANDIDATE_OPEN_RE.test(String(text || ""));
}

export function flushToolSieve(state: ToolSieveState | null | undefined, toolsRaw: unknown): ToolSieveFlushResult {
  const buffered = state ? state.buffer : "";
  if (!buffered) return { text: "", toolCalls: null };
  if (findToolSieveCandidateStart(buffered) < 0) return { text: buffered, toolCalls: null };
  const [clean, toolCalls] = parseToolCalls(buffered, toolsRaw);
  return { text: clean, toolCalls: toolCalls.length ? toolCalls : null };
}
