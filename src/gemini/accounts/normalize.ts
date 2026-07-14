import { bytesToHex } from "../../shared/crypto";
import { TEXT_ENCODER } from "../../shared/encoding";
import { parseCookieHeader, serializeCookieMap } from "../cookies";

const SESSION_TOKEN_FIELDS = new Set(["SNlM0e", "session_token", "at"]);

export function cleanAccountString(value: unknown): string {
	return String(value ?? "")
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.replace(/;+$/g, "")
		.trim();
}

export function normalizeGeminiCookieHeader(cookieHeader: unknown): string {
	const cookies = parseCookieHeader(cookieHeader);
	for (const field of SESSION_TOKEN_FIELDS) cookies.delete(field);
	return serializeCookieMap(cookies);
}

export async function sha256Hex(value: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(value));
	return bytesToHex(new Uint8Array(buf));
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
