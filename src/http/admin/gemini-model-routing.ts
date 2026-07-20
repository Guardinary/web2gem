import type { RuntimeConfig, WorkerEnv } from "../../config";
import {
	createGeminiAccountAdminServiceFromEnv,
	GeminiAccountAdminError,
} from "../../gemini/accounts/admin";
import {
	assertNoAdminQueryParams,
	modelFamilyFromPathSegment,
	normalizeModelRoutePriority,
} from "../../gemini/accounts/admin-input";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import { jsonResponse } from "../core/json";
import {
	adminAuthorized,
	adminErrorResponse,
	assertAdminBodyAbsent,
	readAdminJson,
} from "./gemini-accounts";

const MODEL_ROUTING_PREFIX = "/admin/model-routing";

export function isGeminiModelRoutingAdminPath(path: string): boolean {
	return (
		path === MODEL_ROUTING_PREFIX || path.startsWith(`${MODEL_ROUTING_PREFIX}/`)
	);
}

export async function handleGeminiModelRoutingAdminRequest(
	request: Request,
	env: WorkerEnv,
	cfg: RuntimeConfig,
	url: URL,
): Promise<Response> {
	const auth = adminAuthorized(request, cfg);
	if (!auth.ok)
		return adminErrorResponse(
			new GeminiAccountAdminError(401, auth.code, auth.message),
		);

	try {
		const method = request.method.toUpperCase();
		if (method === "GET" && url.pathname === MODEL_ROUTING_PREFIX) {
			assertNoAdminQueryParams(url.searchParams);
			const service = createGeminiAccountAdminServiceFromEnv(env, cfg);
			return jsonResponse(await service.modelRoutingOverview());
		}

		const family = modelRoutingFamilyFromPath(url.pathname);
		if (family && method === "PUT") {
			assertNoAdminQueryParams(url.searchParams);
			const body = await readAdminJson(request);
			normalizeModelRoutePriority(body, family);
			const service = createGeminiAccountAdminServiceFromEnv(env, cfg);
			return jsonResponse(
				await service.replaceModelRoutePriority(family, body),
			);
		}
		if (family && method === "DELETE") {
			assertNoAdminQueryParams(url.searchParams);
			assertAdminBodyAbsent(request);
			const service = createGeminiAccountAdminServiceFromEnv(env, cfg);
			return jsonResponse(await service.clearModelRoutePriority(family));
		}
		return adminErrorResponse(
			new GeminiAccountAdminError(
				404,
				"admin_route_not_found",
				"admin route not found",
			),
		);
	} catch (error) {
		if (!(error instanceof GeminiAccountAdminError))
			log(cfg, `admin model routing error: ${errorLogSummary(error)}`);
		return adminErrorResponse(error);
	}
}

function modelRoutingFamilyFromPath(path: string) {
	if (!path.startsWith(`${MODEL_ROUTING_PREFIX}/`)) return null;
	const segment = path.slice(MODEL_ROUTING_PREFIX.length + 1);
	if (!segment || segment.includes("/")) return null;
	return modelFamilyFromPathSegment(segment);
}
