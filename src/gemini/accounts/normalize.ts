import { parseCookieHeader, serializeCookieMap } from "../cookies";
import { bytesToHex, TEXT_ENCODER } from "../../shared/runtime";
import type { GeminiAccountCategory, GeminiAccountPublic, GeminiAccountRow } from "./types";

const SESSION_TOKEN_FIELDS = new Set(["SNlM0e", "session_token", "at"]);

export function cleanAccountString(value: unknown): string {
  return String(value ?? "").trim().replace(/^['"]|['"]$/g, "").replace(/;+$/g, "").trim();
}

export function normalizeGeminiCookieHeader(cookieHeader: unknown): string {
  const cookies = parseCookieHeader(cookieHeader);
  for (const field of SESSION_TOKEN_FIELDS) cookies.delete(field);
  return serializeCookieMap(cookies);
}

export function geminiAccountCategory(input: {
  cookieHeader: string;
  sessionToken?: string | null;
}): GeminiAccountCategory {
  const cookies = parseCookieHeader(input.cookieHeader);
  const psid = cleanAccountString(cookies.get("__Secure-1PSID"));
  const psidts = cleanAccountString(cookies.get("__Secure-1PSIDTS"));
  const sessionToken = cleanAccountString(input.sessionToken);
  if (psid && psidts && sessionToken) return "full_session";
  if (psid && psidts) return "psid_psidts";
  if (psid) return "psid_only";
  if (sessionToken || cookies.size > 0) return "session_token_only";
  return "missing_session";
}

export async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(value));
  return bytesToHex(new Uint8Array(buf));
}

export async function hashNullable(value: string | null | undefined): Promise<string | null> {
  const text = cleanAccountString(value);
  return text ? sha256Hex(text) : null;
}

export async function accountRowId(input: {
  cookieHeader: string;
  accountId?: string | null;
}): Promise<string> {
  const cookies = parseCookieHeader(input.cookieHeader);
  const source = [
    normalizeGeminiCookieHeader(input.cookieHeader),
    cleanAccountString(cookies.get("__Secure-1PSID")),
    cleanAccountString(cookies.get("__Secure-1PSIDTS")),
    cleanAccountString(input.accountId),
  ].join("\0");
  return sha256Hex(source);
}

export function cookiePreview(cookieHeader: string): string {
  const cookies = parseCookieHeader(cookieHeader);
  const psid = cleanAccountString(cookies.get("__Secure-1PSID"));
  return psid ? "present" : "";
}

export function sanitizeGeminiAccount(row: GeminiAccountRow): GeminiAccountPublic {
  const { cookie_header: cookieHeader, sapisid, session_token: sessionToken, ...rest } = row;
  return {
    ...rest,
    has_cookie: !!cookieHeader,
    has_sapisid: !!sapisid,
    has_session_token: !!sessionToken,
    cookie_preview: cookiePreview(cookieHeader),
  };
}

export function changedRows(meta: unknown): number | null {
  if (!meta || typeof meta !== "object") return null;
  const record = meta as Record<string, unknown>;
  for (const key of ["changes", "changedRows", "rows_written", "rowsWritten"]) {
    const value = Number(record[key]);
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return null;
}
