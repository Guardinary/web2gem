import { isDurableGeminiAccountIssue } from "./domain";
import { capabilityMatchesRoute, type GeminiRouteTuple } from "./routes";
import type {
	GeminiAccountAcquireOptions,
	GeminiAccountModelCapability,
	GeminiAccountSnapshotRow,
} from "./types";

export type PoolSelection = {
	row: GeminiAccountSnapshotRow;
	capability: GeminiAccountModelCapability | null;
	route: GeminiRouteTuple | null;
};

type PoolSelectionInput = {
	rows: readonly GeminiAccountSnapshotRow[];
	nowMs: number;
	excludedAccountIds: ReadonlySet<string>;
	options: GeminiAccountAcquireOptions;
	capabilitiesByAccount: ReadonlyMap<
		string,
		ReadonlyMap<string, GeminiAccountModelCapability>
	>;
	inFlight: ReadonlyMap<string, number>;
	roundRobinCursor: number;
};

export type PoolSelectionResult = {
	selection: PoolSelection | null;
	nextRoundRobinCursor: number;
};

export function choosePoolAccount(
	input: PoolSelectionInput,
): PoolSelectionResult {
	let cursor = input.roundRobinCursor;
	const selectable = input.rows
		.filter((row) => !input.excludedAccountIds.has(row.id))
		.filter((row) => row.enabled !== 0)
		.filter((row) => !isDurableGeminiAccountIssue(row.issue))
		.filter(
			(row) =>
				row.cooldown_until_ms == null || row.cooldown_until_ms <= input.nowMs,
		);

	function result(selection: PoolSelection | null): PoolSelectionResult {
		return { selection, nextRoundRobinCursor: cursor };
	}

	function chooseLeastInFlight(
		rows: readonly GeminiAccountSnapshotRow[],
	): GeminiAccountSnapshotRow | null {
		if (!rows.length) return null;
		const rotated: GeminiAccountSnapshotRow[] = [];
		for (let index = 0; index < rows.length; index++) {
			const row = rows[(cursor + index) % rows.length];
			if (row) rotated.push(row);
		}
		let best: GeminiAccountSnapshotRow | null = null;
		for (const row of rotated) {
			if (
				!best ||
				(input.inFlight.get(row.id) || 0) < (input.inFlight.get(best.id) || 0)
			)
				best = row;
		}
		if (best) {
			const index = rows.findIndex((row) => row.id === best?.id);
			cursor = index < 0 ? 0 : (index + 1) % rows.length;
		}
		return best;
	}

	function exactRouteForAccount(
		accountId: string,
		candidates: readonly GeminiRouteTuple[],
		freshAfterMs: number,
	): {
		capability: GeminiAccountModelCapability;
		route: GeminiRouteTuple;
	} | null {
		for (const route of candidates) {
			const capability = input.capabilitiesByAccount
				.get(accountId)
				?.get(route.providerModelId);
			if (
				capability?.available === true &&
				capability.checkedAtMs >= freshAfterMs &&
				capabilityMatchesRoute(capability, route)
			)
				return { capability, route };
		}
		return null;
	}

	function hasFreshCapabilitySnapshot(
		accountId: string,
		freshAfterMs: number,
	): boolean {
		const capabilities = input.capabilitiesByAccount.get(accountId);
		if (!capabilities) return false;
		for (const capability of capabilities.values()) {
			if (capability.checkedAtMs >= freshAfterMs) return true;
		}
		return false;
	}

	if (!selectable.length) return result(null);
	const mode = input.options.capabilityMode || "off";
	const requirement = input.options.routeRequirement;
	const freshAfter = Number(input.options.capabilityFreshAfterMs) || 0;
	if (!requirement) {
		const row = chooseLeastInFlight(selectable);
		return result(row ? { row, capability: null, route: null } : null);
	}

	const requiresExact = requirement.fallbackRoute === null;
	if (mode !== "off" || requiresExact) {
		for (const route of requirement.candidates) {
			const capableRows = selectable.filter(
				(candidate) =>
					exactRouteForAccount(candidate.id, [route], freshAfter) !== null,
			);
			const row = chooseLeastInFlight(capableRows);
			if (!row) continue;
			const matched = exactRouteForAccount(row.id, [route], freshAfter);
			if (matched) return result({ row, ...matched });
		}
		if (mode === "strict" || requiresExact) return result(null);
		const unknownOrStale = selectable.filter(
			(row) => !hasFreshCapabilitySnapshot(row.id, freshAfter),
		);
		const fallback = chooseLeastInFlight(unknownOrStale);
		return result(
			fallback && requirement.fallbackRoute
				? {
						row: fallback,
						capability: null,
						route: requirement.fallbackRoute,
					}
				: null,
		);
	}

	const best = chooseLeastInFlight(selectable);
	if (!best) return result(null);
	const matched = exactRouteForAccount(
		best.id,
		requirement.candidates,
		freshAfter,
	);
	return result({
		row: best,
		capability: matched?.capability || null,
		route: matched?.route || requirement.fallbackRoute,
	});
}
