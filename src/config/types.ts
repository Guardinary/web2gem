export type WorkerEnv = Partial<Record<keyof WorkerBindings, unknown>>;

export type RuntimeProfile = "worker" | "docker";

export type GeminiAccountRuntimeContext = {
	accountId: string;
	cookieHash: string;
	observeSetCookie?: (values: readonly string[]) => void;
};

export type StaticRuntimeConfig = Readonly<{
	gemini_bl: string;
	gemini_origin: string;
	upstream_socket: boolean;
	default_model: string;
	retry_attempts: number;
	gemini_account_max_attempts: number;
	gemini_account_refresh_interval_sec: number;
	gemini_account_capability_ttl_sec: number;
	gemini_account_capability_mode: "off" | "prefer" | "strict";
	retry_delay_sec: number;
	request_timeout_sec: number;
	request_body_max_bytes: number;
	log_requests: boolean;
	current_input_file_enabled: boolean;
	current_input_file_min_bytes: number;
	generic_file_upload_max_bytes: number;
	api_keys: readonly string[];
	admin_key: string;
}>;

export type RuntimeExecutionContext = {
	supports_authenticated_session?: boolean;
	execution_ctx?: Pick<ExecutionContext, "waitUntil">;
	runtime_profile?: RuntimeProfile;
};

export type GeminiAccountSessionContext = {
	cookie: string;
	sapisid: string;
	gemini_account?: GeminiAccountRuntimeContext;
};

export type RuntimeConfig = StaticRuntimeConfig &
	RuntimeExecutionContext &
	GeminiAccountSessionContext;
