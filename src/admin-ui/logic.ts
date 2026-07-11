import type { AccountIdentifier, GeminiAccount, MutationResult } from "./types";

export type BatchImportItem = {
	label?: string;
	psid: string;
	psidts: string;
};

export const METADATA_CSV_FIELDS = [
	"id",
	"row_id",
	"label",
	"enabled",
	"status",
	"account_category",
	"state_reason",
	"last_used_at_ms",
	"last_success_at_ms",
	"last_failure_at_ms",
	"last_refresh_at_ms",
	"last_refresh_attempt_at_ms",
	"cooldown_until_ms",
	"success_count",
	"failure_count",
	"last_error_code",
	"last_error_message_redacted",
	"source",
	"source_id",
	"source_name",
] as const;

export function text(value: unknown): string {
	return String(value == null ? "" : value);
}

export function identifier(account: GeminiAccount): AccountIdentifier {
	return { id: account.id };
}

export function identifierKey(account: GeminiAccount): string {
	return account.id;
}

export function accountDisplayName(account: GeminiAccount): string {
	return account.label || account.id || account.row_id || "Gemini account";
}

export function accountBusyLabel(action: string): string {
	if (!action) return "";
	return `${action.slice(0, 1).toUpperCase()}${action.slice(1)} in progress`;
}

export function destructiveConfirmationText(
	count: number,
	targetLabel: string,
): { title: string; description: string; confirmLabel: string } {
	const rawScope = targetLabel.trim() || "selected account(s)";
	const scope = rawScope.replace("(s)", count === 1 ? "" : "s");
	return {
		title: count === 1 ? "Delete account?" : `Delete ${count} accounts?`,
		description: `This permanently deletes ${count} ${scope}. This action cannot be undone.`,
		confirmLabel: count === 1 ? "Delete account" : `Delete ${count} accounts`,
	};
}

export function accountResourcePath(
	id: string,
	action?: "refresh" | "check",
): string {
	const resource = `/admin/accounts/${encodeURIComponent(id)}`;
	return action ? `${resource}/${action}` : resource;
}

export function mergeMutationResults(
	results: readonly MutationResult[],
): MutationResult {
	const merged: MutationResult = {};
	for (const key of [
		"added",
		"duplicates",
		"skipped",
		"updated",
		"removed",
		"checked",
		"refreshed",
		"unchanged",
		"failed",
	] as const) {
		const values = results
			.map((result) => result[key])
			.filter((value): value is number => value !== undefined);
		if (values.length)
			merged[key] = values.reduce((sum, value) => sum + value, 0);
	}
	const errors = results.flatMap((result) => result.errors || []);
	if (errors.length) merged.errors = errors;
	return merged;
}

export function formatTime(value: number | null): string {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return "-";
	try {
		return new Date(n).toLocaleString();
	} catch {
		return "-";
	}
}

export function relativeTime(
	value: number | null,
	nowMs: number = Date.now(),
): string {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return "-";
	const diff = n - nowMs;
	const abs = Math.abs(diff);
	let unit = "m";
	let amount = Math.round(abs / 60000);
	if (abs >= 86400000) {
		unit = "d";
		amount = Math.round(abs / 86400000);
	} else if (abs >= 3600000) {
		unit = "h";
		amount = Math.round(abs / 3600000);
	}
	if (amount < 1) amount = 1;
	return diff >= 0 ? `in ${amount}${unit}` : `${amount}${unit} ago`;
}

export function safeNumber(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

export function isCooling(
	account: GeminiAccount,
	nowMs: number = Date.now(),
): boolean {
	return Number(account.cooldown_until_ms) > nowMs;
}

export function isRefreshable(account: GeminiAccount): boolean {
	return (
		["full_session", "psid_psidts"].includes(text(account.account_category)) &&
		Number(account.enabled) === 1
	);
}

export function sessionLabel(account: GeminiAccount): string {
	return (
		[
			account.has_cookie ? "cookie" : "",
			account.has_sapisid ? "sapisid" : "",
			account.has_session_token ? "token" : "",
		]
			.filter(Boolean)
			.join(" / ") || "missing"
	);
}

export function resultSummary(action: string, result: MutationResult): string {
	const parts: string[] = [];
	for (const key of [
		"checked",
		"refreshed",
		"unchanged",
		"updated",
		"removed",
		"added",
		"duplicates",
		"skipped",
		"failed",
	] as const) {
		if (result[key] != null) parts.push(`${key} ${result[key]}`);
	}
	const firstError =
		result.errors?.[0]?.error || result.errors?.[0]?.message || "";
	return `${action} completed${parts.length ? `: ${parts.join(", ")}` : ""}${firstError ? ` - ${firstError}` : ""}`;
}

export function validateCookieValue(value: string, name: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${name} is required`);
	if (
		normalized.includes("=") ||
		normalized.includes(";") ||
		normalized.startsWith("{") ||
		normalized.startsWith("[") ||
		/__Secure-1PSID/i.test(normalized)
	) {
		throw new Error(`${name} must be a value only`);
	}
	return normalized;
}

export function parseBatchImport(rawValue: string): BatchImportItem[] {
	const raw = rawValue.trim();
	if (!raw) return [];
	const out: BatchImportItem[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const textLine = line.trim();
		if (!textLine) continue;
		const parts = textLine
			.split(/[,\t ]+/)
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length < 2) throw new Error("Batch rows require PSID and PSIDTS");
		const item = {
			psid: validateCookieValue(parts[0] || "", "__Secure-1PSID"),
			psidts: validateCookieValue(parts[1] || "", "__Secure-1PSIDTS"),
		};
		const label = parts.slice(2).join(" ").trim();
		out.push(label ? { ...item, label } : item);
	}
	if (!out.length) throw new Error("Batch import is empty");
	return out;
}

export function metadataCsv(rows: readonly GeminiAccount[]): string {
	return [
		METADATA_CSV_FIELDS.join(","),
		...rows.map((account) =>
			METADATA_CSV_FIELDS.map((field) => csvValue(account[field])).join(","),
		),
	].join("\n");
}

function csvValue(value: unknown): string {
	return `"${text(value).replace(/"/g, '""')}"`;
}
