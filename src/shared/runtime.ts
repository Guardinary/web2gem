import type { ErrorWithMetadata } from "./types";

export const TEXT_ENCODER = new TextEncoder();
export const TEXT_DECODER = new TextDecoder();
export const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

// ─── 小工具 ──────────────────────────────────────────────────────────────────
type LogConfig = { log_requests?: unknown } | null | undefined;

function formatLogMessage(msg: unknown): string {
  if (msg instanceof Error) return msg.stack || msg.message;
  if (typeof msg === "string") return msg;
  if (msg === null || msg === undefined) return String(msg);
  if (typeof msg === "object") {
    try { return JSON.stringify(msg); } catch (_) { /* fall through */ }
  }
  return String(msg);
}

function writeLog(msg: unknown): void {
  try { console.log(`[web2gem] ${formatLogMessage(msg)}`); } catch (_) {}
}

export function log(cfg: LogConfig, msg: unknown): void {
  if (cfg && cfg.log_requests) {
    writeLog(msg);
  }
}

export function logInfo(cfg: LogConfig, msg: unknown): void {
  if (cfg && cfg.log_requests) {
    writeLog(msg);
  }
}

export function nowMs(): number {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

export function elapsedMs(startMs: number): number {
  return Math.max(0, Math.round((nowMs() - startMs) * 10) / 10);
}

export function logStage(cfg: LogConfig, stage: string, fields: Record<string, unknown> = {}): void {
  if (!cfg || !cfg.log_requests) return;
  const parts = [`stage=${stage}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    parts.push(`${key}=${String(value)}`);
  }
  logInfo(cfg, parts.join(" "));
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  const wait = schedulerWait();
  if (wait) return wait(ms, signal || undefined);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type SchedulerWait = (ms: number, options?: { signal?: AbortSignal }) => Promise<void>;

function schedulerWait(): ((ms: number, signal?: AbortSignal) => Promise<void>) | null {
  const schedulerLike = (globalThis as typeof globalThis & { scheduler?: { wait?: SchedulerWait } }).scheduler;
  const wait = schedulerLike && schedulerLike.wait;
  if (typeof wait !== "function") return null;
  return async (ms: number, signal?: AbortSignal) => {
    try {
      await wait.call(schedulerLike, ms, signal ? { signal } : undefined);
    } catch (e) {
      if (signal && signal.aborted) throw abortError(signal);
      throw e;
    }
  };
}

export function timeoutSignal(ms: unknown): AbortSignal | undefined {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    return AbortSignal.timeout(n);
  }
  if (typeof AbortController === "undefined") return undefined;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), n);
  return ac.signal;
}

export function abortError(signal?: AbortSignal | null): ErrorWithMetadata {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const err: ErrorWithMetadata = new Error(reason ? String(reason) : "request aborted");
  err.name = "AbortError";
  err.code = "request_aborted";
  return err;
}

export function isAbortError(e: unknown): boolean {
  const err = e as Partial<ErrorWithMetadata> | null | undefined;
  return !!err && (err.name === "AbortError" || err.code === "request_aborted");
}

export function upstreamErrorMessage(e: unknown): string {
  const err = e as { message?: unknown } | null | undefined;
  return String((err && err.message) || e);
}

export function upstreamErrorCode(e: unknown): string | undefined {
  const err = e as Partial<ErrorWithMetadata> | null | undefined;
  return err && typeof err.code === "string" ? err.code : undefined;
}

export function upstreamErrorStatus(e: unknown): number | undefined {
  const err = e as Partial<ErrorWithMetadata> | null | undefined;
  const status = Number(err && err.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

export function errorLogSummary(e: unknown): string {
  const err = e as Partial<ErrorWithMetadata> | null | undefined;
  const parts: string[] = [];
  const name = err && typeof err.name === "string" && err.name ? err.name : typeof e;
  parts.push(`type=${name}`);
  const code = upstreamErrorCode(e);
  if (code) parts.push(`code=${code}`);
  const status = upstreamErrorStatus(e);
  if (status) parts.push(`status=${status}`);
  const upstreamStatus = Number(err && err.upstreamStatus);
  if (Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599) {
    parts.push(`upstreamStatus=${upstreamStatus}`);
  }
  const rawLength = Number(err && err.rawLength);
  if (Number.isInteger(rawLength) && rawLength >= 0) parts.push(`rawLength=${rawLength}`);
  return parts.join(" ");
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal && signal.aborted) throw abortError(signal);
}

export function linkedSignal(...signals: Array<AbortSignal | null | undefined>): { signal: AbortSignal | undefined; cleanup: () => void } {
  const live = signals.filter((signal): signal is AbortSignal => !!signal);
  if (!live.length) return { signal: undefined, cleanup() {} };
  if (live.length === 1) return { signal: live[0], cleanup() {} };
  const ac = new AbortController();
  const listeners: Array<[AbortSignal, () => void]> = [];
  const cleanup = () => {
    while (listeners.length) {
      const entry = listeners.pop();
      if (!entry) continue;
      const [signal, listener] = entry;
      try { signal.removeEventListener("abort", listener); } catch (_) {}
    }
  };
  const abort = (signal: AbortSignal) => {
    cleanup();
    if (!ac.signal.aborted) {
      try { ac.abort(signal && signal.reason); } catch (_) { ac.abort(); }
    }
  };
  for (const signal of live) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = () => abort(signal);
    listeners.push([signal, listener]);
    signal.addEventListener("abort", listener, { once: true });
  }
  return { signal: ac.signal, cleanup };
}

export function canFallbackAfterSocketError(_method: string, error: unknown): boolean {
  // socketHttp only throws here before it has returned a Response object to the
  // caller. In production Cloudflare sockets can close before any response
  // headers are readable; falling back to fetch preserves the old working
  // behavior for POST generation requests.
  return !(error && typeof error === "object" && (error as Partial<ErrorWithMetadata>).upstreamStatus);
}

export function randomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return arr;
}

const HEX_BYTE_TABLE = Array.from({ length: 256 }, (_value, index) => index.toString(16).padStart(2, "0"));

function bytesToHex(bytes: Uint8Array): string {
  const toHex = (bytes as Uint8Array & { toHex?: () => string }).toHex;
  if (typeof toHex === "function") return toHex.call(bytes);
  const parts = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) parts[i] = HEX_BYTE_TABLE[bytes[i] || 0] || "00";
  return parts.join("");
}

/** 生成 `n` 个十六进制字符的随机串(n/2 个随机字节)。 */
export function randHex(n: number): string {
  const bytes = randomBytes(Math.ceil(n / 2));
  return bytesToHex(bytes).slice(0, n);
}

export function uuid(): string {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = ((b[6] || 0) & 0x0f) | 0x40;
  b[8] = ((b[8] || 0) & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** SAPISIDHASH 鉴权头(对 "<ts> <sapisid> <origin>" 做 SHA-1)。 */
export let _sapisidHashCache: { key: string; value: string } = { key: "", value: "" };

export async function makeSapisidHash(sapisid: string): Promise<string> {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error("crypto.subtle is required to build SAPISIDHASH");
  }
  const ts = nowSec();
  const cacheKey = `${ts}\x00${sapisid}`;
  if (_sapisidHashCache.key === cacheKey) return _sapisidHashCache.value;
  const data = TEXT_ENCODER.encode(`${ts} ${sapisid} https://gemini.google.com`);
  const buf = await globalThis.crypto.subtle.digest("SHA-1", data);
  const hex = bytesToHex(new Uint8Array(buf));
  const value = `SAPISIDHASH ${ts}_${hex}`;
  _sapisidHashCache = { key: cacheKey, value };
  return value;
}
