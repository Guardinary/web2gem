import { GEMINI_PUBLIC_FAMILIES, publicNamesForFamily } from "../../models";
import type { GeminiPublicFamily } from "../../models";
import type { GeminiModelRoutingOverview } from "./admin-types";
import type {
	GeminiAccountCapabilityRow,
	GeminiAccountModelCapability,
	GeminiCatalogRoute,
	GeminiRouteTuple,
} from "./route-types";
import {
	availableAccountsByRoute,
	capabilityFromRow,
	catalogRoute,
	geminiRouteKey,
	knownTierLabel,
	mergeSavedAndDiscoveredRoutes,
	uniqueRouteTuples,
} from "./routes";
import type {
	GeminiAccountRuntimeStore,
	GeminiAccountSnapshotRow,
} from "./runtime-types";

export async function loadSelectedCapabilityRows(
	store: GeminiAccountRuntimeStore,
	rows: readonly GeminiAccountSnapshotRow[],
	globalRowsPromise: Promise<GeminiAccountCapabilityRow[]> | null,
): Promise<GeminiAccountCapabilityRow[]> {
	if (!rows.length) return [];
	const accountIds = rows.map((row) => row.id);
	if (store.listAccountCapabilities)
		return store.listAccountCapabilities(accountIds);
	if (!globalRowsPromise) return [];
	const selectedIds = new Set(accountIds);
	return (await globalRowsPromise).filter((row) =>
		selectedIds.has(row.account_id),
	);
}

export function freshSelectableCatalogRoutes(
	rows: readonly GeminiAccountSnapshotRow[],
	capabilitiesByAccount: ReadonlyMap<
		string,
		ReadonlyMap<string, GeminiAccountModelCapability>
	>,
	freshAfterMs: number,
): GeminiCatalogRoute[] {
	const routes: GeminiCatalogRoute[] = [];
	for (const row of rows) {
		const capabilities = [
			...(capabilitiesByAccount.get(row.id)?.values() || []),
		].sort((a, b) => a.discoveryOrder - b.discoveryOrder);
		for (const capability of capabilities) {
			if (!capability.available || capability.checkedAtMs < freshAfterMs)
				continue;
			routes.push(catalogRoute(row.id, capability));
		}
	}
	return routes;
}

export function persistedCatalogRoutes(
	rows: readonly GeminiAccountCapabilityRow[],
): GeminiCatalogRoute[] {
	const routes: GeminiCatalogRoute[] = [];
	for (const row of rows) {
		if (row.available === 0) continue;
		const capability = capabilityFromRow(row);
		if (!capability) continue;
		routes.push(catalogRoute(row.account_id, capability));
	}
	return routes;
}

export function buildModelRoutingOverview(
	version: string,
	routePriorities: ReadonlyMap<GeminiPublicFamily, readonly GeminiRouteTuple[]>,
	persisted: readonly GeminiCatalogRoute[],
	fresh: readonly GeminiCatalogRoute[],
): GeminiModelRoutingOverview {
	const availableAccounts = availableAccountsByRoute(fresh);
	return {
		version,
		families: GEMINI_PUBLIC_FAMILIES.map((family) => {
			const saved = routePriorities.get(family) || [];
			const savedKeys = new Set(saved.map(geminiRouteKey));
			const discovered = uniqueRouteTuples(
				persisted.filter((route) => route.family === family),
			);
			return {
				family,
				publicNames: publicNamesForFamily(family),
				configured: saved.length > 0,
				routes: mergeSavedAndDiscoveredRoutes(saved, discovered).map(
					(route) => {
						const accountCount =
							availableAccounts.get(geminiRouteKey(route))?.size || 0;
						return {
							...route,
							label: knownTierLabel(route),
							available: accountCount > 0,
							configured: savedKeys.has(geminiRouteKey(route)),
							accountCount,
						};
					},
				),
			};
		}),
	};
}
