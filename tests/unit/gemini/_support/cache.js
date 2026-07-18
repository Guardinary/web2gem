import { withPatchedGlobal } from "../../_support/globals.js";

export async function withCaches(cache, run) {
	return withPatchedGlobal("caches", { default: cache }, run);
}

export function createMemoryCache() {
	const store = new Map();
	const stats = { match: 0, put: 0, delete: 0 };
	return {
		stats,
		async match(request) {
			stats.match += 1;
			const response = store.get(request.url);
			return response ? response.clone() : undefined;
		},
		async put(request, response) {
			stats.put += 1;
			store.set(request.url, response.clone());
		},
		async delete(request) {
			stats.delete += 1;
			return store.delete(request.url);
		},
	};
}
