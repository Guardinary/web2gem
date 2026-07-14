import type { RuntimeConfig, WorkerEnv } from "../../config";
import {
	createGeminiAccountAdminServiceFromEnv,
	GeminiAccountAdminError,
} from "../../gemini/accounts/admin";
import {
	accountIdFromPathSegment,
	assertNoAdminQueryParams,
	listFilterFromSearchParams,
} from "../../gemini/accounts/admin-input";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import { isRecord } from "../../shared/types";
import { jsonResponse, readJsonRequest } from "../core/json";

const ADMIN_PATH_PREFIX = "/admin/accounts";
const ADMIN_MAX_BODY_BYTES = 256 * 1024;

export function isGeminiAccountAdminPath(path: string): boolean {
	return path === ADMIN_PATH_PREFIX || path.startsWith(`${ADMIN_PATH_PREFIX}/`);
}

export async function handleGeminiAccountAdminRequest(
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
		const path = url.pathname;
		if (method === "GET" && path === ADMIN_PATH_PREFIX) {
			const filter = listFilterFromSearchParams(url.searchParams);
			const service = createGeminiAccountAdminServiceFromEnv(env, cfg);
			return jsonResponse(await service.overview(filter));
		}

		if (method === "POST" && path === ADMIN_PATH_PREFIX) {
			assertNoAdminQueryParams(url.searchParams);
			const body = await readAdminJson(request);
			const service = createGeminiAccountAdminServiceFromEnv(env, cfg);
			return jsonResponse(await service.create(body));
		}

		if (method === "POST" && path === `${ADMIN_PATH_PREFIX}/actions`) {
			assertNoAdminQueryParams(url.searchParams);
			const body = await readAdminJson(request);
			const service = createGeminiAccountAdminServiceFromEnv(env, cfg);
			return jsonResponse(await service.runBulkAction(body));
		}

		const resource = accountResourceFromPath(path);
		if (resource) {
			if (method === "PATCH" && resource.action === null) {
				assertNoAdminQueryParams(url.searchParams);
				const body = await readAdminJson(request);
				const service = createGeminiAccountAdminServiceFromEnv(env, cfg);
				return jsonResponse(await service.update(resource.id, body));
			}
			if (method === "DELETE" && resource.action === null) {
				assertNoAdminQueryParams(url.searchParams);
				assertAdminBodyAbsent(request);
				const service = createGeminiAccountAdminServiceFromEnv(env, cfg);
				return jsonResponse(await service.delete(resource.id));
			}
			if (method === "POST" && resource.action === "refresh") {
				assertNoAdminQueryParams(url.searchParams);
				assertAdminBodyAbsent(request);
				const service = createGeminiAccountAdminServiceFromEnv(env, cfg);
				return jsonResponse(await service.refresh(resource.id));
			}
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
			log(cfg, `admin error: ${errorLogSummary(error)}`);
		return adminErrorResponse(error);
	}
}

type AdminAuthResult =
	| { ok: true }
	| { ok: false; code: string; message: string };

export function adminAuthorized(
	request: Request,
	cfg: Pick<RuntimeConfig, "admin_key">,
): AdminAuthResult {
	const configured = cfg.admin_key || "";
	if (!configured) {
		return {
			ok: false,
			code: "admin_auth_not_configured",
			message: "admin auth is not configured",
		};
	}
	const headers = request.headers;
	const auth = headers.get("authorization") || "";
	const bearer = /^\s*Bearer\s+(.+?)\s*$/i.exec(auth);
	const candidates = [
		bearer?.[1] ? bearer[1] : null,
		headers.get("x-admin-key"),
	];
	for (const raw of candidates) {
		const candidate = String(raw || "").trim();
		if (!candidate) continue;
		if (timingSafeStringEqual(candidate, configured)) return { ok: true };
	}
	return { ok: false, code: "invalid_admin_key", message: "invalid admin key" };
}

async function readAdminJson(request: Request) {
	const parsed = await readJsonRequest(request, {
		maxBodyBytes: ADMIN_MAX_BODY_BYTES,
		oversizedError: {
			status: 413,
			code: "admin_request_body_too_large",
			message: "admin request body is too large",
		},
	});
	if (parsed.error !== undefined) {
		throw new GeminiAccountAdminError(
			parsed.status || 400,
			parsed.code || "invalid_admin_json",
			parsed.error,
		);
	}
	if (!isRecord(parsed.value)) {
		throw new GeminiAccountAdminError(
			400,
			"invalid_admin_json",
			"request body must be a JSON object",
		);
	}
	return parsed.value;
}

function adminErrorResponse(error: unknown): Response {
	if (error instanceof GeminiAccountAdminError) {
		return jsonResponse(
			{ error: { message: error.message, code: error.code } },
			error.status,
		);
	}
	return jsonResponse(
		{
			error: {
				message: "admin request failed",
				code: "admin_request_failed",
			},
		},
		500,
	);
}

type AccountResourceRoute = {
	id: string;
	action: "refresh" | null;
};

function accountResourceFromPath(path: string): AccountResourceRoute | null {
	if (!path.startsWith(`${ADMIN_PATH_PREFIX}/`)) return null;
	const remainder = path.slice(ADMIN_PATH_PREFIX.length + 1);
	const segments = remainder.split("/");
	if (segments.length === 1 && segments[0])
		return { id: accountIdFromPathSegment(segments[0]), action: null };
	if (segments.length === 2 && segments[0] && segments[1] === "refresh")
		return {
			id: accountIdFromPathSegment(segments[0]),
			action: segments[1],
		};
	return null;
}

function assertAdminBodyAbsent(request: Request): void {
	if (request.body === null) return;
	throw new GeminiAccountAdminError(
		400,
		"admin_request_body_not_allowed",
		"request body is not allowed for this admin route",
	);
}

function timingSafeStringEqual(a: string, b: string): boolean {
	const max = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < max; i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}
