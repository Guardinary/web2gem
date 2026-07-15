import type { GeminiModelCatalog, GeminiModelCatalogEntry } from "../../models";

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
