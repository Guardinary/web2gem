import {
	createRuntimeConfig,
	getConfig,
	type RuntimeConfig,
} from "../../../../../src/config";
import { handleGoogleGenerate } from "../../../../../src/http/google/handlers";
import { parseGoogleGenerationPath } from "../../../../../src/http/google/model-path";

export function googleConfig(
	overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
	return { ...createRuntimeConfig(getConfig()), ...overrides };
}

export function handleGoogle(
	req: Parameters<typeof handleGoogleGenerate>[0],
	cfg: Partial<RuntimeConfig>,
	provider: Parameters<typeof handleGoogleGenerate>[2],
	route: Parameters<typeof handleGoogleGenerate>[3],
): ReturnType<typeof handleGoogleGenerate> {
	return handleGoogleGenerate(req, googleConfig(cfg), provider, route);
}

export function googleRoute(
	path: string,
): NonNullable<ReturnType<typeof parseGoogleGenerationPath>> {
	const route = parseGoogleGenerationPath(path);
	if (!route) throw new Error(`invalid Google route: ${path}`);
	return route;
}
