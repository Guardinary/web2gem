import type { AccountIdentifier, GeminiAccount, MutationResult } from "./types";

export type BatchImportItem = { label?: string; psid: string; psidts: string };

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
	return account.label || account.id || "Gemini account";
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

export function accountResourcePath(id: string): string {
	return `/admin/accounts/${encodeURIComponent(id)}`;
}

export function mergeMutationResults(
	results: readonly MutationResult[],
): MutationResult {
	const merged: MutationResult = {
		processed: 0,
		changed: 0,
		unchanged: 0,
		failed: 0,
	};
	for (const result of results) {
		merged.processed += result.processed;
		merged.changed += result.changed;
		merged.unchanged += result.unchanged;
		merged.failed += result.failed;
	}
	const errors = results.flatMap((result) => result.errors || []);
	if (errors.length) merged.errors = errors;
	return merged;
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

export function isCooling(account: GeminiAccount): boolean {
	return account.state === "cooling";
}

export function resultSummary(action: string, result: MutationResult): string {
	const summary = `processed ${result.processed}, changed ${result.changed}, unchanged ${result.unchanged}, failed ${result.failed}`;
	const firstError = result.errors?.[0]?.message || "";
	return `${action} completed: ${summary}${firstError ? ` - ${firstError}` : ""}`;
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
	)
		throw new Error(`${name} must be a value only`);
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
