export type GeminiPublicFamily = "pro" | "flash" | "flash_lite";

export type ModelConfig = {
	family: GeminiPublicFamily;
	extended: boolean;
	desc: string;
};

export type ResolvedModel =
	| {
			name: string;
			family: GeminiPublicFamily | null;
			extended: boolean;
			dynamicProviderId: string | null;
			error?: undefined;
	  }
	| {
			error: string;
			name?: undefined;
			family?: undefined;
			extended?: undefined;
			dynamicProviderId?: undefined;
	  };

export type GeminiRouteTuple = {
	providerModelId: string;
	capacity: 1 | 2 | 3 | 4;
	capacityField: 12 | 13;
	modelNumber: number;
};

export type GeminiInternalRoute = GeminiRouteTuple & {
	family: GeminiPublicFamily | null;
	displayName: string;
	description: string;
	available: boolean;
	checkedAtMs: number;
	discoveryOrder: number;
};

export type GeminiKnownTierLabel = "Basic" | "Plus" | "Advanced";

export type GeminiCatalogRoute = GeminiInternalRoute & {
	accountId: string;
};

export type GeminiModelCatalogEntry = {
	id: string;
	family: GeminiPublicFamily | null;
	providerModelId: string | null;
	displayName: string;
	description: string;
	extended: boolean;
};

export type GeminiModelCatalog = {
	createdAtSec: number;
	entries: readonly GeminiModelCatalogEntry[];
};

export const DEFAULT_MODEL = "gemini-3.5-flash";
export const GEMINI_MODEL_HEADER_KEY = "x-goog-ext-525001261-jspb";
export const GEMINI_PUBLIC_FAMILIES = ["pro", "flash", "flash_lite"] as const;
export const MAX_GEMINI_PROVIDER_MODEL_ID_CHARS = 256;
export const MAX_GEMINI_MODEL_NUMBER = 64;
export const MAX_GEMINI_MODEL_DISPLAY_NAME_CODE_POINTS = 256;
export const MAX_GEMINI_MODEL_DESCRIPTION_CODE_POINTS = 2048;
export const MAX_GEMINI_DISCOVERED_MODELS = 128;

const EXTENDED_SUFFIX = "-extended";
const PROVIDER_MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const FAMILY_PUBLIC_NAMES = {
	pro: ["gemini-3.1-pro", "gemini-3.1-pro-extended"],
	flash: ["gemini-3.5-flash", "gemini-3.5-flash-extended"],
	flash_lite: ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite-extended"],
} as const satisfies Record<GeminiPublicFamily, readonly [string, string]>;

const FAMILY_DESCRIPTIONS = {
	pro: "Gemini Pro model",
	flash: "Fast general-purpose Gemini model",
	flash_lite: "Lightweight Gemini Flash model",
} as const satisfies Record<GeminiPublicFamily, string>;

export const MODELS: Readonly<Record<string, ModelConfig>> = Object.freeze(
	Object.fromEntries(
		GEMINI_PUBLIC_FAMILIES.flatMap((family) => {
			const [standardName, extendedName] = FAMILY_PUBLIC_NAMES[family];
			return [
				[
					standardName,
					{
						family,
						extended: false,
						desc: FAMILY_DESCRIPTIONS[family],
					},
				],
				[
					extendedName,
					{
						family,
						extended: true,
						desc: `${FAMILY_DESCRIPTIONS[family]} with extended thinking`,
					},
				],
			] as const;
		}),
	),
);

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

export function publicNamesForFamily(
	family: GeminiPublicFamily,
): readonly [string, string] {
	return FAMILY_PUBLIC_NAMES[family];
}

export function buildGeminiModelCatalog(
	routes: readonly GeminiCatalogRoute[],
	createdAtMs: number = Date.now(),
): GeminiModelCatalog {
	const entries: GeminiModelCatalogEntry[] = [
		{
			id: FAMILY_PUBLIC_NAMES.flash[0],
			family: "flash",
			providerModelId: null,
			displayName: "Gemini 3.5 Flash",
			description: FAMILY_DESCRIPTIONS.flash,
			extended: false,
		},
		{
			id: FAMILY_PUBLIC_NAMES.flash[1],
			family: "flash",
			providerModelId: null,
			displayName: "Gemini 3.5 Flash Extended",
			description: `${FAMILY_DESCRIPTIONS.flash} with extended thinking`,
			extended: true,
		},
	];
	const seen = new Set(entries.map((entry) => entry.id));
	const exactDynamicIds = new Set<string>();
	for (const route of routes) {
		if (
			route.available &&
			!route.family &&
			!familyForProviderModelId(route.providerModelId) &&
			!isKnownPublicModelName(route.providerModelId)
		)
			exactDynamicIds.add(route.providerModelId);
	}
	for (const route of routes) {
		if (!route.available) continue;
		const family =
			route.family || familyForProviderModelId(route.providerModelId);
		if (!family && isKnownPublicModelName(route.providerModelId)) continue;
		const [standardId, extendedId] = family
			? FAMILY_PUBLIC_NAMES[family]
			: [route.providerModelId, `${route.providerModelId}${EXTENDED_SUFFIX}`];
		for (const [id, extended] of [
			[standardId, false],
			[extendedId, true],
		] as const) {
			if (extended && exactDynamicIds.has(id)) continue;
			if (seen.has(id)) continue;
			seen.add(id);
			entries.push({
				id,
				family,
				providerModelId: route.providerModelId,
				displayName: extended
					? `${route.displayName} Extended`
					: route.displayName,
				description: route.description,
				extended,
			});
		}
	}
	return {
		createdAtSec: Math.floor(Math.max(0, createdAtMs) / 1000),
		entries,
	};
}

export function resolveModelFromCatalog(
	modelName: unknown,
	def: unknown,
	catalog: GeminiModelCatalog,
): ResolvedModel {
	const known = resolveModel(modelName, def);
	if (known.name !== undefined) return known;
	const hasExplicitModel = modelName !== undefined && modelName !== null;
	const name = String(hasExplicitModel ? modelName : def || "").trim();
	for (const candidate of dynamicProviderModelCandidates(name)) {
		const available = catalog.entries.some(
			(entry) =>
				entry.providerModelId === candidate.providerModelId &&
				entry.family === null &&
				entry.extended === candidate.extended,
		);
		if (!available) continue;
		return {
			name,
			family: null,
			extended: candidate.extended,
			dynamicProviderId: candidate.providerModelId,
		};
	}
	return known;
}

export function familyForProviderModelId(
	providerModelId: string,
): GeminiPublicFamily | null {
	return (
		KNOWN_PROVIDER_MODELS[providerModelId as keyof typeof KNOWN_PROVIDER_MODELS]
			?.family ?? null
	);
}

function isKnownPublicModelName(value: string): boolean {
	return Object.hasOwn(MODELS, value);
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

export function isGeminiProviderModelId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_GEMINI_PROVIDER_MODEL_ID_CHARS &&
		PROVIDER_MODEL_ID_PATTERN.test(value)
	);
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

export function dynamicProviderModelCandidates(
	name: unknown,
): readonly { providerModelId: string; extended: boolean }[] {
	if (typeof name !== "string" || !name) return [];
	const candidates: { providerModelId: string; extended: boolean }[] = [];
	if (isGeminiProviderModelId(name))
		candidates.push({ providerModelId: name, extended: false });
	if (name.endsWith(EXTENDED_SUFFIX)) {
		const base = name.slice(0, -EXTENDED_SUFFIX.length);
		if (isGeminiProviderModelId(base))
			candidates.push({ providerModelId: base, extended: true });
	}
	return candidates;
}

export function buildGeminiModelHeaders(
	route: GeminiRouteTuple,
	extended: boolean,
	sessionId: string,
): Record<string, string> {
	if (!isGeminiRouteTuple(route)) throw new Error("invalid Gemini route tuple");
	const normalizedSessionId = String(sessionId || "")
		.trim()
		.toUpperCase();
	if (!normalizedSessionId)
		throw new Error("missing Gemini provider session id");
	const payload: unknown[] = [
		1,
		null,
		null,
		null,
		route.providerModelId,
		null,
		null,
		0,
		[4, 5, 6, 8],
		null,
		null,
	];
	payload[route.capacityField - 1] = route.capacity;
	payload[route.capacityField] = null;
	payload[route.capacityField + 1] = null;
	payload[route.capacityField + 2] = route.modelNumber;
	payload.push(extended ? 2 : 1, normalizedSessionId);
	return {
		[GEMINI_MODEL_HEADER_KEY]: JSON.stringify(payload),
		"x-goog-ext-73010989-jspb": "[0]",
		"x-goog-ext-73010990-jspb": "[0,0,0]",
	};
}

export function resolveModel(modelName: unknown, def: unknown): ResolvedModel {
	const hasExplicitModel = modelName !== undefined && modelName !== null;
	const name = String(hasExplicitModel ? modelName : def || "").trim();
	const config = MODELS[name];
	if (!config) return { error: `model ${name || "(empty)"} is not available` };
	return {
		name,
		family: config.family,
		extended: config.extended,
		dynamicProviderId: null,
	};
}
