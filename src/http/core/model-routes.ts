import { VERSION } from "../../config";
import type { GeminiModelCatalog, GeminiModelCatalogEntry } from "../../models";
import { MODELS } from "../../models";

const SUPPORTED_GENERATION_METHODS = [
	"generateContent",
	"streamGenerateContent",
] as const;

export const HEALTH_JSON = JSON.stringify({
	status: "ok",
	version: VERSION,
	models: Object.keys(MODELS),
});
export const NOT_FOUND_JSON = JSON.stringify({ error: "not found" });

export function openAIModelListJson(catalog: GeminiModelCatalog): string {
	return JSON.stringify({
		object: "list",
		data: catalog.entries.map((entry) => openAIModel(entry, catalog)),
	});
}

export function openAIModelDetailJson(
	catalog: GeminiModelCatalog,
	id: string,
): string | null {
	const entry = catalog.entries.find((candidate) => candidate.id === id);
	return entry ? JSON.stringify(openAIModel(entry, catalog)) : null;
}

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

function openAIModel(
	entry: GeminiModelCatalogEntry,
	catalog: GeminiModelCatalog,
) {
	return {
		id: entry.id,
		object: "model",
		created: catalog.createdAtSec,
		owned_by: "google",
	};
}

function googleModel(entry: GeminiModelCatalogEntry) {
	return {
		name: `models/${entry.id}`,
		displayName: entry.displayName,
		description: entry.description,
		supportedGenerationMethods: SUPPORTED_GENERATION_METHODS,
	};
}
