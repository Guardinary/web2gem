import type { RuntimeConfig, WorkerEnv } from "../../config";
import { createGeminiAccountAdminServiceFromEnv, GeminiAccountAdminError } from "../../gemini/accounts/admin";
import { errorLogSummary } from "../../shared/runtime";
import { isRecord } from "../../shared/types";
import { jsonResponse, readJsonRequest } from "../core/json";

const ADMIN_PATH_PREFIX = "/admin/gemini/accounts";
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
  if (!auth.ok) return adminErrorResponse(new GeminiAccountAdminError(401, auth.code, auth.message));

  try {
    const service = createGeminiAccountAdminServiceFromEnv(env, cfg);
    const method = request.method.toUpperCase();
    const path = url.pathname;
    if (method === "GET" && path === ADMIN_PATH_PREFIX) {
      return jsonResponse(await service.list(listFilterFromUrl(url)));
    }

    if (method === "POST" && path === ADMIN_PATH_PREFIX) {
      return jsonResponse(await service.create(await readAdminJson(request)));
    }

    if ((method === "PATCH" && path === ADMIN_PATH_PREFIX) || (method === "POST" && path === `${ADMIN_PATH_PREFIX}/update`)) {
      return jsonResponse(await service.update(await readAdminJson(request)));
    }

    if (method === "POST" && path === `${ADMIN_PATH_PREFIX}/enable`) {
      return jsonResponse(await service.setEnabled(await readAdminJson(request), true));
    }

    if (method === "POST" && path === `${ADMIN_PATH_PREFIX}/disable`) {
      return jsonResponse(await service.setEnabled(await readAdminJson(request), false));
    }

    if (method === "DELETE" && path === ADMIN_PATH_PREFIX) {
      return jsonResponse(await service.delete(await readAdminJson(request)));
    }

    if (method === "POST" && path === `${ADMIN_PATH_PREFIX}/refresh`) {
      return jsonResponse(await service.refresh(await readAdminJson(request)));
    }

    if (method === "POST" && path === `${ADMIN_PATH_PREFIX}/check`) {
      return jsonResponse(await service.check(await readAdminJson(request)));
    }

    return adminErrorResponse(new GeminiAccountAdminError(404, "admin_route_not_found", "admin route not found"));
  } catch (error) {
    return adminErrorResponse(error);
  }
}

type AdminAuthResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function adminAuthorized(request: Request, cfg: Pick<RuntimeConfig, "admin_keys">): AdminAuthResult {
  const keys = cfg.admin_keys || [];
  if (!keys.length) {
    return { ok: false, code: "admin_auth_not_configured", message: "admin auth is not configured" };
  }
  const headers = request.headers;
  const auth = headers.get("authorization") || "";
  const bearer = /^\s*Bearer\s+(.+?)\s*$/i.exec(auth);
  const candidates = [
    bearer && bearer[1] ? bearer[1] : null,
    headers.get("x-admin-key"),
    headers.get("x-api-key"),
  ];
  for (const raw of candidates) {
    const candidate = String(raw || "").trim();
    if (!candidate) continue;
    let matched = false;
    for (const configured of keys) {
      matched = timingSafeStringEqual(candidate, String(configured || "")) || matched;
    }
    if (matched) return { ok: true };
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
    throw new GeminiAccountAdminError(parsed.status || 400, parsed.code || "invalid_admin_json", parsed.error);
  }
  if (!isRecord(parsed.value)) {
    throw new GeminiAccountAdminError(400, "invalid_admin_json", "request body must be a JSON object");
  }
  return parsed.value;
}

function listFilterFromUrl(url: URL) {
  const enabledRaw = url.searchParams.get("enabled");
  const filter: { limit?: number; cursor?: string; status?: string; enabled?: boolean } = {};
  const limit = parseInteger(url.searchParams.get("limit"));
  if (limit !== undefined) filter.limit = limit;
  const cursor = url.searchParams.get("cursor") || "";
  if (cursor) filter.cursor = cursor;
  const status = url.searchParams.get("status") || "";
  if (status) filter.status = status;
  if (enabledRaw != null) filter.enabled = /^(1|true|yes|on)$/i.test(enabledRaw);
  return filter;
}

function parseInteger(value: string | null): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

function adminErrorResponse(error: unknown): Response {
  if (error instanceof GeminiAccountAdminError) {
    return jsonResponse({ error: { message: error.message, code: error.code } }, error.status);
  }
  return jsonResponse({
    error: {
      message: "admin request failed",
      code: "admin_request_failed",
      detail: errorLogSummary(error),
    },
  }, 500);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
