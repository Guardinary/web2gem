import type { GeminiAccountOutcome, GeminiAccountSnapshotRow } from "./types";

export type AccountRuntimeState = {
	cookieHeader: string;
	cookieHash: string;
	lastRotateAtMs: number;
};

export function positiveIntOption(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function applyOutcomeToSnapshot(
	rows: readonly GeminiAccountSnapshotRow[],
	accountId: string,
	outcome: GeminiAccountOutcome,
): GeminiAccountSnapshotRow[] {
	return rows.map((row) => {
		if (row.id !== accountId) return row;
		if (outcome.kind === "success") {
			return {
				...row,
				issue: null,
				cooldown_until_ms: null,
				last_used_at_ms: outcome.nowMs,
			};
		}
		return {
			...row,
			issue: outcome.issue ?? row.issue,
			cooldown_until_ms:
				outcome.issue === undefined
					? row.cooldown_until_ms
					: (outcome.cooldownUntilMs ?? null),
			last_used_at_ms: outcome.nowMs,
		};
	});
}

export function applyRefreshToSnapshot(
	rows: readonly GeminiAccountSnapshotRow[],
	accountId: string,
	cookieHeader: string,
	cookieHash: string,
): GeminiAccountSnapshotRow[] {
	return rows.map((row) =>
		row.id === accountId
			? {
					...row,
					cookie_header: cookieHeader,
					cookie_hash: cookieHash,
				}
			: row,
	);
}
