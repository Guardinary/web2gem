import { type GeminiPublicFamily, isGeminiProviderModelId } from "../../models";
import type {
	GeminiAccountCapabilityRow,
	GeminiAccountModelCapability,
	GeminiCatalogRoute,
	GeminiKnownTierLabel,
	GeminiModelRoutePriorityRow,
	GeminiRouteTuple,
} from "./route-types";

const MAX_GEMINI_MODEL_NUMBER = 64;

const KNOWN_PROVIDER_MODELS = {
	"9d8ca3786ebdfbea": { family: "pro", modelNumber: 3, tier: "Basic" },
	e6fa609c3fa255c0: { family: "pro", modelNumber: 3, tier: null },
	fbb127bbb056c959: { family: "flash", modelNumber: 1, tier: "Basic" },
	"56fdd199312815e2": { family: "flash", modelNumber: 1, tier: null },
	cf41b0e0dd7d53e5: {
		family: "flash_lite",
		modelNumber: 6,
		tier: "Basic",
	},
	"8c46e95b1a07cecc": {
		family: "flash_lite",
		modelNumber: 6,
		tier: null,
	},
} as const satisfies Record<
	string,
	{
		family: GeminiPublicFamily;
		modelNumber: number;
		tier: "Basic" | null;
	}
>;

const BASIC_ROUTES = {
	pro: {
		providerModelId: "9d8ca3786ebdfbea",
		capacity: 1,
		capacityField: 12,
		modelNumber: 3,
	},
	flash: {
		providerModelId: "fbb127bbb056c959",
		capacity: 1,
		capacityField: 12,
		modelNumber: 1,
	},
	flash_lite: {
		providerModelId: "cf41b0e0dd7d53e5",
		capacity: 1,
		capacityField: 12,
		modelNumber: 6,
	},
} as const satisfies Record<GeminiPublicFamily, GeminiRouteTuple>;

function familyForProviderModelId(
	providerModelId: string,
): GeminiPublicFamily | null {
	return (
		KNOWN_PROVIDER_MODELS[providerModelId as keyof typeof KNOWN_PROVIDER_MODELS]
			?.family ?? null
	);
}

export function modelNumberForProviderModelId(providerModelId: string): number {
	return (
		KNOWN_PROVIDER_MODELS[providerModelId as keyof typeof KNOWN_PROVIDER_MODELS]
			?.modelNumber ?? 1
	);
}

export function basicRouteForFamily(
	family: GeminiPublicFamily,
): GeminiRouteTuple {
	return { ...BASIC_ROUTES[family] };
}

export function knownTierLabel(
	route: Pick<
		GeminiRouteTuple,
		"providerModelId" | "capacity" | "capacityField"
	>,
): GeminiKnownTierLabel | null {
	const known =
		KNOWN_PROVIDER_MODELS[
			route.providerModelId as keyof typeof KNOWN_PROVIDER_MODELS
		];
	if (!known || route.capacityField !== 12) return null;
	if (route.capacity === 1 && known.tier === "Basic") return "Basic";
	if (route.capacity === 4 && known.tier === null) return "Plus";
	if (route.capacity === 2 && known.tier === null) return "Advanced";
	return null;
}

export function isGeminiRouteTuple(value: unknown): value is GeminiRouteTuple {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const route = value as Partial<GeminiRouteTuple>;
	return (
		isGeminiProviderModelId(route.providerModelId) &&
		(route.capacity === 1 ||
			route.capacity === 2 ||
			route.capacity === 3 ||
			route.capacity === 4) &&
		(route.capacityField === 12 || route.capacityField === 13) &&
		Number.isInteger(route.modelNumber) &&
		Number(route.modelNumber) >= 1 &&
		Number(route.modelNumber) <= MAX_GEMINI_MODEL_NUMBER
	);
}

export function geminiRouteKey(route: GeminiRouteTuple): string {
	if (!isGeminiRouteTuple(route)) throw new Error("invalid Gemini route tuple");
	return JSON.stringify([
		route.providerModelId,
		route.capacity,
		route.capacityField,
		route.modelNumber,
	]);
}

export function parseGeminiRouteKey(value: unknown): GeminiRouteTuple | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed) || parsed.length !== 4) return null;
		const route = {
			providerModelId: parsed[0],
			capacity: parsed[1],
			capacityField: parsed[2],
			modelNumber: parsed[3],
		};
		return isGeminiRouteTuple(route) ? route : null;
	} catch (_) {
		return null;
	}
}

export function capabilityFromRow(
	row: GeminiAccountCapabilityRow,
): GeminiAccountModelCapability | null {
	const route = {
		providerModelId: row.model_id,
		capacity: row.capacity,
		capacityField: row.capacity_field,
		modelNumber: row.model_number,
	};
	if (!isGeminiRouteTuple(route)) return null;
	return {
		modelId: route.providerModelId,
		displayName: row.display_name,
		description: row.description,
		available: row.available !== 0,
		capacity: route.capacity,
		capacityField: route.capacityField,
		modelNumber: route.modelNumber,
		discoveryOrder: row.discovery_order,
		checkedAtMs: row.checked_at_ms,
	};
}

export function capabilitiesByAccount(
	rows: readonly GeminiAccountCapabilityRow[],
): Map<string, Map<string, GeminiAccountModelCapability>> {
	const out = new Map<string, Map<string, GeminiAccountModelCapability>>();
	for (const row of rows) {
		const capability = capabilityFromRow(row);
		if (!capability) continue;
		let account = out.get(row.account_id);
		if (!account) {
			account = new Map();
			out.set(row.account_id, account);
		}
		account.set(row.model_id, capability);
	}
	return out;
}

export function catalogRoute(
	accountId: string,
	capability: GeminiAccountModelCapability,
): GeminiCatalogRoute {
	return {
		accountId,
		providerModelId: capability.modelId,
		family: familyForProviderModelId(capability.modelId),
		displayName: capability.displayName,
		description: capability.description,
		capacity: capability.capacity,
		capacityField: capability.capacityField,
		modelNumber: capability.modelNumber,
		available: capability.available,
		checkedAtMs: capability.checkedAtMs,
		discoveryOrder: capability.discoveryOrder,
	};
}

export function routePrioritiesByFamily(
	rows: readonly GeminiModelRoutePriorityRow[],
): Map<GeminiPublicFamily, GeminiRouteTuple[]> {
	const out = new Map<GeminiPublicFamily, GeminiRouteTuple[]>();
	for (const row of rows) {
		const route = {
			providerModelId: row.provider_model_id,
			capacity: row.capacity,
			capacityField: row.capacity_field,
			modelNumber: row.model_number,
		};
		if (!isGeminiRouteTuple(route)) continue;
		let family = out.get(row.family);
		if (!family) {
			family = [];
			out.set(row.family, family);
		}
		family.push(route);
	}
	return out;
}

export function uniqueRouteTuples(
	routes: readonly GeminiCatalogRoute[],
): GeminiRouteTuple[] {
	const out: GeminiRouteTuple[] = [];
	const seen = new Set<string>();
	for (const route of routes) {
		const tuple: GeminiRouteTuple = {
			providerModelId: route.providerModelId,
			capacity: route.capacity,
			capacityField: route.capacityField,
			modelNumber: route.modelNumber,
		};
		const key = geminiRouteKey(tuple);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(tuple);
	}
	return out;
}

export function availableAccountsByRoute(
	routes: readonly GeminiCatalogRoute[],
): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const route of routes) {
		const key = geminiRouteKey(route);
		let accounts = out.get(key);
		if (!accounts) {
			accounts = new Set();
			out.set(key, accounts);
		}
		accounts.add(route.accountId);
	}
	return out;
}

export function mergeSavedAndDiscoveredRoutes(
	saved: readonly GeminiRouteTuple[],
	discovered: readonly GeminiRouteTuple[],
): GeminiRouteTuple[] {
	const out = [...saved];
	const seen = new Set(saved.map(geminiRouteKey));
	for (const route of discovered) {
		const key = geminiRouteKey(route);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(route);
	}
	return out;
}

export function reconcileRoutePriority(
	saved: readonly GeminiRouteTuple[],
	discovered: readonly GeminiRouteTuple[],
): GeminiRouteTuple[] {
	const discoveredByKey = new Map(
		discovered.map((route) => [geminiRouteKey(route), route]),
	);
	const out: GeminiRouteTuple[] = [];
	const seen = new Set<string>();
	for (const route of saved) {
		const key = geminiRouteKey(route);
		const available = discoveredByKey.get(key);
		if (!available) continue;
		seen.add(key);
		out.push(available);
	}
	for (const route of discovered) {
		const key = geminiRouteKey(route);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(route);
	}
	return out;
}

export function capabilityMatchesRoute(
	capability: GeminiAccountModelCapability,
	route: GeminiRouteTuple,
): boolean {
	return (
		capability.modelId === route.providerModelId &&
		capability.capacity === route.capacity &&
		capability.capacityField === route.capacityField &&
		capability.modelNumber === route.modelNumber
	);
}
