import type { RuntimeConfig } from "../../../../../src/config";
import {
	GeminiAccountAdminService,
	type GeminiAccountAdminServiceOptions,
} from "../../../../../src/gemini/accounts/admin";
import type {
	GeminiAccountAdminStore,
	GeminiAccountMutationError,
	GeminiAccountMutationResult,
} from "../../../../../src/gemini/accounts/admin-types";
import type { GeminiAccountRuntimeStore } from "../../../../../src/gemini/accounts/runtime-types";
import { baseConfig } from "../../../_support/runtime-config.js";

type AccountStore = GeminiAccountAdminStore & GeminiAccountRuntimeStore;

type ServiceOverrides = Pick<
	GeminiAccountAdminServiceOptions,
	"nowMs" | "rotateCookie" | "verifyAccount"
> & {
	cfg?: RuntimeConfig | ReturnType<typeof baseConfig>;
};

function serviceConfig(
	overrides?: RuntimeConfig | ReturnType<typeof baseConfig>,
): RuntimeConfig {
	return {
		gemini_bl: "",
		gemini_origin: "https://gemini.google.com",
		upstream_socket: false,
		retry_attempts: 1,
		gemini_account_max_attempts: 10,
		gemini_account_refresh_interval_sec: 600,
		gemini_account_capability_ttl_sec: 3600,
		gemini_account_capability_mode: "prefer",
		retry_delay_sec: 0,
		request_timeout_sec: 30,
		api_keys: [],
		admin_key: "",
		sapisid: "",
		...baseConfig(),
		...overrides,
	};
}

async function successfulVerification(): Promise<{ ok: true; at: string }> {
	return { ok: true, at: "fresh-at" };
}

export function createService(
	store: AccountStore,
	overrides: ServiceOverrides = {},
) {
	return new GeminiAccountAdminService({
		adminStore: store,
		runtimeStore: store,
		cfg: serviceConfig(overrides.cfg),
		nowMs: overrides.nowMs || (() => 1000),
		rotateCookie:
			overrides.rotateCookie ||
			(async () => new Response(null, { status: 200 })),
		verifyAccount: overrides.verifyAccount || successfulVerification,
	});
}

export function mutationCounts(result: GeminiAccountMutationResult) {
	return {
		processed: result.processed,
		changed: result.changed,
		unchanged: result.unchanged,
		failed: result.failed,
	};
}

export function mutationError(
	result: GeminiAccountMutationResult,
	index = 0,
): GeminiAccountMutationError {
	const error = result.errors?.[index];
	if (!error) throw new Error(`missing mutation error at index ${index}`);
	return error;
}
