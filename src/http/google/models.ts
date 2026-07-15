import type { GeminiModelCatalog, GeminiModelCatalogEntry } from "../../models";

const SUPPORTED_GENERATION_METHODS = [
	"generateContent",
	"streamGenerateContent",
] as const;

export function googleModelListJson(catalog: GeminiModelCatalog): string {
	return JSON.stringify({
		models: catalog.entries.map(googleModel),
	});
}

export function googleModelDetailJson(
	catalog: GeminiModelCatalog,
	id: string,
): string | null {
	const entry = catalog.entries.find((candidate) => candidate.id === id);
	return entry ? JSON.stringify(googleModel(entry)) : null;
}

function googleModel(entry: GeminiModelCatalogEntry) {
	return {
		name: `models/${entry.id}`,
		displayName: entry.displayName,
		description: entry.description,
		supportedGenerationMethods: SUPPORTED_GENERATION_METHODS,
	};
}
