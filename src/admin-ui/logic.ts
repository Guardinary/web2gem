import {
	deletionTargetLabel,
	localActionLabel,
	relativeUnit,
	tr,
} from "./i18n";
import { AdminLocalError } from "./local-errors";
import type {
	AccountIdentifier,
	GeminiAccount,
	ModelRoutingOverview,
	MutationResult,
} from "./types";

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
	const localized = localActionLabel(action);
	const label =
		localized === action
			? `${action.slice(0, 1).toUpperCase()}${action.slice(1)}`
			: localized;
	return tr("Busy action", { action: label });
}

export function destructiveConfirmationText(
	count: number,
	targetLabel: string,
): { title: string; description: string; confirmLabel: string } {
	const target = deletionTargetLabel(targetLabel, count);
	return {
		title: tr(count === 1 ? "Delete account title" : "Delete accounts title", {
			count,
		}),
		description: tr("Delete confirmation description", { count, target }),
		confirmLabel: tr(
			count === 1 ? "Delete account action" : "Delete accounts action",
			{ count },
		),
	};
}

export function relativeTime(
	value: number | null,
	nowMs: number = Date.now(),
): string {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return "-";
	const diff = n - nowMs;
	const abs = Math.abs(diff);
	let unit: "m" | "h" | "d" = "m";
	let amount = Math.round(abs / 60000);
	if (abs >= 86400000) {
		unit = "d";
		amount = Math.round(abs / 86400000);
	} else if (abs >= 3600000) {
		unit = "h";
		amount = Math.round(abs / 3600000);
	}
	if (amount < 1) amount = 1;
	const params = { amount, unit: relativeUnit(unit) };
	return diff >= 0
		? tr("Relative future", params)
		: tr("Relative past", params);
}

export function resultSummary(action: string, result: MutationResult): string {
	const params = {
		action: localActionLabel(action, true),
		processed: result.processed,
		changed: result.changed,
		unchanged: result.unchanged,
		failed: result.failed,
	};
	const firstError = result.errors?.[0]?.message || "";
	return firstError
		? tr("Mutation summary with error", { ...params, error: firstError })
		: tr("Mutation summary", params);
}

function normalizeDecimalVersion(value: string): string {
	return value.replace(/^0+(?=\d)/, "");
}

function compareDecimalVersions(left: string, right: string): number {
	const normalizedLeft = normalizeDecimalVersion(left);
	const normalizedRight = normalizeDecimalVersion(right);
	if (normalizedLeft.length !== normalizedRight.length)
		return normalizedLeft.length - normalizedRight.length;
	if (normalizedLeft === normalizedRight) return 0;
	return normalizedLeft < normalizedRight ? -1 : 1;
}

export function newerModelRoutingOverview(
	current: ModelRoutingOverview | null,
	incoming: ModelRoutingOverview,
): ModelRoutingOverview {
	if (!current) return incoming;
	return compareDecimalVersions(incoming.version, current.version) < 0
		? current
		: incoming;
}

export function validateCookieValue(value: string, name: string): string {
	const normalized = value.trim();
	if (!normalized)
		throw new AdminLocalError({
			key: "Cookie value required",
			params: { name },
		});
	if (
		normalized.includes("=") ||
		normalized.includes(";") ||
		normalized.startsWith("{") ||
		normalized.startsWith("[") ||
		/__Secure-1PSID/i.test(normalized)
	)
		throw new AdminLocalError({
			key: "Cookie value only",
			params: { name },
		});
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
		if (parts.length < 2)
			throw new AdminLocalError({ key: "Batch row credentials required" });
		const item = {
			psid: validateCookieValue(parts[0] || "", "__Secure-1PSID"),
			psidts: validateCookieValue(parts[1] || "", "__Secure-1PSIDTS"),
		};
		const label = parts.slice(2).join(" ").trim();
		out.push(label ? { ...item, label } : item);
	}
	return out;
}
