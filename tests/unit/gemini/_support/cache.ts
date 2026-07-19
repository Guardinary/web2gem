import { withPatchedGlobal } from "../../_support/globals.js";

type CacheRun<T> = () => T | PromiseLike<T>;

export async function withCaches<T>(
	cache: unknown,
	run: CacheRun<T>,
): Promise<T> {
	return withPatchedGlobal("caches", { default: cache }, run);
}

export function createMemoryCache() {
	const store = new Map<string, Response>();
	const stats = { match: 0, put: 0, delete: 0 };
	return {
		stats,
		async match(request: Request) {
			stats.match += 1;
			const response = store.get(request.url);
			return response ? response.clone() : undefined;
		},
		async put(request: Request, response: Response) {
			stats.put += 1;
			store.set(request.url, response.clone());
		},
		async delete(request: Request) {
			stats.delete += 1;
			return store.delete(request.url);
		},
	};
}
