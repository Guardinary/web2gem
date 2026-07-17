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

export type ResolvedModelOk = Extract<ResolvedModel, { name: string }>;

export type GeminiModelCatalogSource = {
	providerModelId: string;
	family: GeminiPublicFamily | null;
	displayName: string;
	description: string;
	available: boolean;
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
export const GEMINI_PUBLIC_FAMILIES = ["pro", "flash", "flash_lite"] as const;
export const MAX_GEMINI_PROVIDER_MODEL_ID_CHARS = 256;
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

export function publicNamesForFamily(
	family: GeminiPublicFamily,
): readonly [string, string] {
	return FAMILY_PUBLIC_NAMES[family];
}

export function buildGeminiModelCatalog(
	routes: readonly GeminiModelCatalogSource[],
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
			!isKnownPublicModelName(route.providerModelId)
		)
			exactDynamicIds.add(route.providerModelId);
	}
	for (const route of routes) {
		if (!route.available) continue;
		const family = route.family;
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

function isKnownPublicModelName(value: string): boolean {
	return Object.hasOwn(MODELS, value);
}

export function isGeminiProviderModelId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_GEMINI_PROVIDER_MODEL_ID_CHARS &&
		PROVIDER_MODEL_ID_PATTERN.test(value)
	);
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
