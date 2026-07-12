import { createRuntimeConfig, getConfig, RuntimeConfigError } from "./config";
import {
	authorized,
	corsHeaders,
	jsonResponse,
	jsonTextResponse,
	openAIErrorResponse,
	withCORS,
} from "./http";
import {
	handleChat,
	handleImageEdits,
	handleImageEditsMultipart,
	handleImageGenerations,
	handleResponses,
} from "./http/openai";
import { handleGoogleGenerate } from "./http/google/handlers";
import {
	GOOGLE_MODEL_JSON_BY_ID,
	GOOGLE_MODEL_LIST_JSON,
	HEALTH_JSON,
	NOT_FOUND_JSON,
	OPENAI_MODEL_JSON_BY_ID,
	OPENAI_MODEL_LIST_JSON,
} from "./http/core/model-routes";
import { googleJsonError, readRouteJsonPost } from "./http/core/route-json";
import {
	handleGeminiAccountAdminRequest,
	isGeminiAccountAdminPath,
} from "./http/admin/gemini-accounts";
import {
	handleGeminiAccountAdminUiRequest,
	isGeminiAccountAdminUiPath,
} from "./http/admin/gemini-account-webui";
import { createGeminiCompletionProvider } from "./gemini/completion-provider";
import {
	GEMINI_AUTHENTICATED_SESSION_REQUIRED_CODE,
	GEMINI_AUTHENTICATED_SESSION_REQUIRED_STATUS,
	geminiAuthenticatedSessionRequiredMessage,
	type GeminiAuthenticatedSessionReason,
} from "./shared/errors";
import {
	d1BindingFromEnv,
	getGeminiAccountRuntimeFromEnv,
} from "./gemini/accounts/runtime";
import { elapsedMs, log, logStage, nowMs } from "./shared/logging";
import { errorLogSummary } from "./shared/errors";
import { uuid } from "./shared/crypto";
import type { RuntimeConfig, WorkerEnv } from "./config";
import type { GeminiAccountRuntime } from "./gemini/accounts/runtime";
import type { RouteJsonPostResult } from "./http/core/route-json";

const GOOGLE_GENERATE_PATH_RE =
	/^\/v(?:1beta|1)\/models\/[^/?#]+:generateContent$/;
const GOOGLE_STREAM_GENERATE_PATH_RE =
	/^\/v(?:1beta|1)\/models\/[^/?#]+:streamGenerateContent$/;

export type ApplicationExecutionContext = Pick<
	ExecutionContext,
	"waitUntil"
> & {
	runtimeProfile?: "docker";
};

type ApplicationRequestContext = {
	request: Request;
	env: WorkerEnv;
	cfg: RuntimeConfig;
	url: URL;
	path: string;
};

export async function handleApplicationRequest(
	request: Request,
	env: WorkerEnv,
	executionContext: ApplicationExecutionContext,
): Promise<Response> {
	const method = request.method.toUpperCase();
	const url = new URL(request.url);
	const path = url.pathname;
	const requestId = uuid();
	let activeConfig: RuntimeConfig | undefined;
	let requestStartMs = 0;
	const respond = (response: Response) => {
		const corsResponse = withCORS(response, request);
		const completed = withResponseHeader(
			corsResponse,
			"x-request-id",
			requestId,
		);
		if (activeConfig?.log_requests) {
			logStage(activeConfig, "request_complete", {
				requestId,
				method,
				path,
				status: completed.status,
				ms: elapsedMs(requestStartMs),
			});
		}
		return completed;
	};

	if (method === "OPTIONS") {
		return new Response(null, {
			status: 204,
			headers: corsHeaders(request),
		});
	}

	let cfg: RuntimeConfig;
	try {
		cfg = withAccountPoolAvailability(
			createRuntimeConfig(getConfig(env), {
				execution_ctx: executionContext,
				runtime_profile:
					executionContext.runtimeProfile === "docker" ? "docker" : "worker",
			}),
			env,
		);
		activeConfig = cfg;
		if (cfg.log_requests) requestStartMs = nowMs();
	} catch (error) {
		return respond(invalidRuntimeConfigResponse(error));
	}

	if (isGeminiAccountAdminUiPath(path)) {
		return respond(handleGeminiAccountAdminUiRequest(request));
	}

	if (isGeminiAccountAdminPath(path)) {
		return respond(
			await handleGeminiAccountAdminRequest(request, env, cfg, url),
		);
	}

	if (path !== "/" && !authorized(request, url, cfg)) {
		return respond(openAIErrorResponse("invalid api key", 401));
	}

	const context: ApplicationRequestContext = {
		request,
		env,
		cfg,
		url,
		path,
	};
	try {
		const response = await dispatchApplicationRoute(method, context);
		return respond(response);
	} catch (error) {
		log(cfg, `error: ${errorLogSummary(error)}`);
		return respond(
			jsonResponse(
				{
					error: {
						message: "internal server error",
						code: "internal_server_error",
					},
				},
				500,
			),
		);
	}
}

function withResponseHeader(
	response: Response,
	name: string,
	value: string,
): Response {
	try {
		response.headers.set(name, value);
		return response;
	} catch (_) {
		const headers = new Headers(response.headers);
		headers.set(name, value);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
}

async function dispatchApplicationRoute(
	method: string,
	context: ApplicationRequestContext,
): Promise<Response> {
	if (method === "GET") return handleGetRoute(context.path);
	if (method === "POST") return handlePostRoute(context);
	return jsonTextResponse(NOT_FOUND_JSON, 404);
}

function handleGetRoute(path: string): Response {
	if (path === "/v1/models") return jsonTextResponse(OPENAI_MODEL_LIST_JSON);
	if (path.startsWith("/v1/models/")) {
		const id = decodeURIComponent(path.slice("/v1/models/".length));
		const modelJson = OPENAI_MODEL_JSON_BY_ID.get(id);
		if (!modelJson)
			return openAIErrorResponse(
				`model ${id} is not available`,
				404,
				"model_not_found",
			);
		return jsonTextResponse(modelJson);
	}
	if (path === "/v1beta/models")
		return jsonTextResponse(GOOGLE_MODEL_LIST_JSON);
	if (path.startsWith("/v1beta/models/")) {
		const id = decodeURIComponent(path.slice("/v1beta/models/".length));
		const modelJson = GOOGLE_MODEL_JSON_BY_ID.get(id);
		if (!modelJson)
			return jsonResponse(
				{
					error: {
						message: `model ${id} is not available`,
						code: "model_not_found",
					},
				},
				404,
			);
		return jsonTextResponse(modelJson);
	}
	if (path === "/") return jsonTextResponse(HEALTH_JSON);
	return jsonTextResponse(NOT_FOUND_JSON, 404);
}

async function handlePostRoute(
	context: ApplicationRequestContext,
): Promise<Response> {
	const { request, cfg, env, path } = context;
	if (path === "/v1/chat/completions") {
		return handleOpenAIGenerationJsonPost(
			request,
			cfg,
			env,
			path,
			(body, accountRuntime) =>
				handleChat(body, cfg, createProvider(cfg, accountRuntime)),
		);
	}
	if (path === "/v1/responses") {
		return handleOpenAIGenerationJsonPost(
			request,
			cfg,
			env,
			path,
			(body, accountRuntime) =>
				handleResponses(body, cfg, createProvider(cfg, accountRuntime)),
		);
	}
	if (path === "/v1/images/generations") {
		return handleOpenAIGenerationJsonPost(
			request,
			cfg,
			env,
			path,
			(body, accountRuntime) =>
				handleImageGenerations(body, cfg, createProvider(cfg, accountRuntime)),
			"image",
		);
	}
	if (path === "/v1/images/edits") {
		if (isMultipartFormRequest(request)) {
			const accountRuntime = requiredGeminiAccountRuntimeFromEnv(env);
			if (!accountRuntime)
				return authenticatedSessionRequiredOpenAIResponse("image");
			return handleImageEditsMultipart(
				request,
				cfg,
				createProvider(cfg, accountRuntime),
			);
		}
		return handleOpenAIGenerationJsonPost(
			request,
			cfg,
			env,
			path,
			(body, accountRuntime) =>
				handleImageEdits(body, cfg, createProvider(cfg, accountRuntime)),
			"image",
		);
	}
	if (GOOGLE_GENERATE_PATH_RE.test(path)) {
		return handleGoogleGenerationJsonPost(
			request,
			cfg,
			env,
			path,
			(body, accountRuntime) =>
				handleGoogleGenerate(
					body,
					cfg,
					createProvider(cfg, accountRuntime),
					path,
					false,
				),
		);
	}
	if (GOOGLE_STREAM_GENERATE_PATH_RE.test(path)) {
		return handleGoogleGenerationJsonPost(
			request,
			cfg,
			env,
			path,
			(body, accountRuntime) =>
				handleGoogleGenerate(
					body,
					cfg,
					createProvider(cfg, accountRuntime),
					path,
					true,
				),
		);
	}
	return jsonTextResponse(NOT_FOUND_JSON, 404);
}

function createProvider(
	cfg: RuntimeConfig,
	accountRuntime: GeminiAccountRuntime | null,
) {
	return createGeminiCompletionProvider(cfg, { accountRuntime });
}

function withAccountPoolAvailability(
	cfg: RuntimeConfig,
	env: WorkerEnv,
): RuntimeConfig {
	if (!d1BindingFromEnv(env)) return cfg;
	return { ...cfg, supports_authenticated_session: true };
}

function requiredGeminiAccountRuntimeFromEnv(
	env: WorkerEnv,
): GeminiAccountRuntime | null {
	return getGeminiAccountRuntimeFromEnv(env);
}

function authenticatedSessionRequiredOpenAIResponse(
	reason: GeminiAuthenticatedSessionReason,
): Response {
	return openAIErrorResponse(
		geminiAuthenticatedSessionRequiredMessage(reason),
		GEMINI_AUTHENTICATED_SESSION_REQUIRED_STATUS,
		GEMINI_AUTHENTICATED_SESSION_REQUIRED_CODE,
		reason,
	);
}

async function handleOpenAIGenerationJsonPost(
	request: Request,
	cfg: RuntimeConfig,
	env: WorkerEnv,
	path: string,
	handler: (
		body: NonNullable<RouteJsonPostResult["value"]>,
		accountRuntime: GeminiAccountRuntime | null,
	) => Promise<Response>,
	requiredReason: GeminiAuthenticatedSessionReason | null = null,
): Promise<Response> {
	const parsed = await readRouteJsonPost(request, cfg, path);
	if (parsed.error !== undefined)
		return openAIErrorResponse(
			parsed.error,
			parsed.status || 400,
			parsed.code,
			parsed.reason,
		);
	const accountRuntime = requiredGeminiAccountRuntimeFromEnv(env);
	if (requiredReason && !accountRuntime)
		return authenticatedSessionRequiredOpenAIResponse(requiredReason);
	return handler(parsed.value, accountRuntime);
}

async function handleGoogleGenerationJsonPost(
	request: Request,
	cfg: RuntimeConfig,
	env: WorkerEnv,
	path: string,
	handler: (
		body: NonNullable<RouteJsonPostResult["value"]>,
		accountRuntime: GeminiAccountRuntime | null,
	) => Promise<Response>,
): Promise<Response> {
	const parsed = await readRouteJsonPost(request, cfg, path);
	if (parsed.error !== undefined)
		return jsonResponse(
			googleJsonError(parsed.error, parsed.code, parsed.reason),
			parsed.status || 400,
		);
	const accountRuntime = requiredGeminiAccountRuntimeFromEnv(env);
	return handler(parsed.value, accountRuntime);
}

function isMultipartFormRequest(request: Request): boolean {
	const contentType = request.headers.get("content-type") || "";
	return (
		contentType.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data"
	);
}

function invalidRuntimeConfigResponse(error: unknown): Response {
	if (error instanceof RuntimeConfigError) {
		return jsonResponse(
			{
				error: {
					message: "invalid runtime configuration",
					code: error.code,
					setting: error.setting,
					reason: error.reason,
				},
			},
			500,
		);
	}
	return jsonResponse(
		{
			error: {
				message: "invalid runtime configuration",
				code: "invalid_runtime_config",
			},
		},
		500,
	);
}
