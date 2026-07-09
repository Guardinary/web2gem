import { getConfig } from "./config";
import { authorized, corsHeaders, jsonResponse, jsonTextResponse, openAIErrorResponse, withCORS } from "./http";
import { handleChat, handleImageEdits, handleImageEditsMultipart, handleImageGenerations, handleResponses } from "./http/openai";
import { handleGoogleGenerate } from "./http/google/handlers";
import { GOOGLE_MODEL_JSON_BY_ID, GOOGLE_MODEL_LIST_JSON, HEALTH_JSON, NOT_FOUND_JSON, OPENAI_MODEL_JSON_BY_ID, OPENAI_MODEL_LIST_JSON } from "./http/core/model-routes";
import { googleJsonError, readRouteJsonPost } from "./http/core/route-json";
import { handleGeminiAccountAdminRequest, isGeminiAccountAdminPath } from "./http/admin/gemini-accounts";
import { createGeminiCompletionProvider } from "./gemini/completion-provider";
import { createGeminiAccountRuntimeFromEnv } from "./gemini/accounts/runtime";
import { errorLogSummary, log } from "./shared/runtime";
import type { RuntimeConfig } from "./config";
import type { GeminiAccountRuntime } from "./gemini/accounts/runtime";
import type { RouteJsonPostResult } from "./http/core/route-json";

const GOOGLE_GENERATE_PATH_RE = /^\/v(?:1beta|1)\/models\/[^/?#]+:generateContent$/;
const GOOGLE_STREAM_GENERATE_PATH_RE = /^\/v(?:1beta|1)\/models\/[^/?#]+:streamGenerateContent$/;

export default {
  async fetch(request: Request, env: Record<string, unknown>, _ctx: ExecutionContext) {
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    const cfg = { ...getConfig(env), execution_ctx: _ctx };
    const url = new URL(request.url);
    const path = url.pathname;
    const respond = (response: Response) => withCORS(response, request);

    if (isGeminiAccountAdminPath(path)) {
      return respond(await handleGeminiAccountAdminRequest(request, env, cfg, url));
    }

    // 鉴权:配置了 API_KEYS 时,除健康检查 "/" 外的所有接口都需要有效 key
    // (含 /v1/* 与 /v1beta/*,防止 Google 原生端点被绕过白嫖)。
    if (path !== "/" && !authorized(request, url, cfg)) {
      return respond(openAIErrorResponse("invalid api key", 401));
    }

    try {
      if (method === "GET") {
        if (path === "/v1/models") {
          return respond(jsonTextResponse(OPENAI_MODEL_LIST_JSON));
        }
        if (path.startsWith("/v1/models/")) {
          const id = decodeURIComponent(path.slice("/v1/models/".length));
          const modelJson = OPENAI_MODEL_JSON_BY_ID.get(id);
          if (!modelJson) return respond(openAIErrorResponse(`model ${id} is not available`, 404, "model_not_found"));
          return respond(jsonTextResponse(modelJson));
        }
        if (path === "/v1beta/models") {
          return respond(jsonTextResponse(GOOGLE_MODEL_LIST_JSON));
        }
        if (path.startsWith("/v1beta/models/")) {
          const id = decodeURIComponent(path.slice("/v1beta/models/".length));
          const modelJson = GOOGLE_MODEL_JSON_BY_ID.get(id);
          if (!modelJson) return respond(jsonResponse({ error: { message: `model ${id} is not available`, code: "model_not_found" } }, 404));
          return respond(jsonTextResponse(modelJson));
        }
        if (path === "/") {
          return respond(jsonTextResponse(HEALTH_JSON));
        }
        return respond(jsonTextResponse(NOT_FOUND_JSON, 404));
      }

      if (method === "POST") {
        const accountRuntime = createGeminiAccountRuntimeFromEnv(env);
        if (path === "/v1/chat/completions") {
          return respond(await handleOpenAIJsonPost(request, cfg, path, (body) => handleChat(body, cfg, createProvider(cfg, accountRuntime))));
        }
        if (path === "/v1/responses") {
          return respond(await handleOpenAIJsonPost(request, cfg, path, (body) => handleResponses(body, cfg, createProvider(cfg, accountRuntime))));
        }
        if (path === "/v1/images/generations") {
          return respond(await handleOpenAIJsonPost(request, cfg, path, (body) => handleImageGenerations(body, cfg, createProvider(cfg, accountRuntime))));
        }
        if (path === "/v1/images/edits") {
          if (isMultipartFormRequest(request)) {
            return respond(await handleImageEditsMultipart(request, cfg, createProvider(cfg, accountRuntime)));
          }
          return respond(await handleOpenAIJsonPost(request, cfg, path, (body) => handleImageEdits(body, cfg, createProvider(cfg, accountRuntime))));
        }
        if (GOOGLE_GENERATE_PATH_RE.test(path)) {
          return respond(await handleGoogleJsonPost(request, cfg, path, (body) => handleGoogleGenerate(body, cfg, createProvider(cfg, accountRuntime), path, false)));
        }
        if (GOOGLE_STREAM_GENERATE_PATH_RE.test(path)) {
          return respond(await handleGoogleJsonPost(request, cfg, path, (body) => handleGoogleGenerate(body, cfg, createProvider(cfg, accountRuntime), path, true)));
        }
        return respond(jsonTextResponse(NOT_FOUND_JSON, 404));
      }

      return respond(jsonTextResponse(NOT_FOUND_JSON, 404));
    } catch (e) {
      const err = e as { stack?: unknown; message?: unknown } | null | undefined;
      log(cfg, `error: ${errorLogSummary(e)}`);
      return respond(jsonResponse({ error: { message: String((err && err.message) || e) } }, 500));
    }
  },
};


// Stable public helper exports for the bundled worker module.
export * from "./public-exports";

function createProvider(cfg: RuntimeConfig, accountRuntime: GeminiAccountRuntime | null) {
  return createGeminiCompletionProvider(cfg, { accountRuntime });
}

async function handleOpenAIJsonPost(
  request: Request,
  cfg: RuntimeConfig,
  path: string,
  handler: (body: NonNullable<RouteJsonPostResult["value"]>) => Promise<Response>,
): Promise<Response> {
  const parsed = await readRouteJsonPost(request, cfg, path);
  if (parsed.error !== undefined) return openAIErrorResponse(parsed.error, parsed.status || 400, parsed.code);
  return handler(parsed.value);
}

async function handleGoogleJsonPost(
  request: Request,
  cfg: RuntimeConfig,
  path: string,
  handler: (body: NonNullable<RouteJsonPostResult["value"]>) => Promise<Response>,
): Promise<Response> {
  const parsed = await readRouteJsonPost(request, cfg, path);
  if (parsed.error !== undefined) return jsonResponse(googleJsonError(parsed.error, parsed.code), parsed.status || 400);
  return handler(parsed.value);
}

function isMultipartFormRequest(request: Request): boolean {
  const contentType = request.headers.get("content-type") || "";
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data";
}
