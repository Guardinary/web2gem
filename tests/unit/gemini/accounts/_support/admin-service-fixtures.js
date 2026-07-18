import { GeminiAccountAdminService } from "../../../../../src/gemini/accounts/admin";
import { baseConfig } from "../../../_support/runtime-config.js";

export function createService(store, overrides = {}) {
	return new GeminiAccountAdminService({
		adminStore: store,
		runtimeStore: store,
		cfg: overrides.cfg || baseConfig(),
		nowMs: overrides.nowMs || (() => 1000),
		rotateCookie:
			overrides.rotateCookie ||
			(async () => new Response(null, { status: 200 })),
		verifyAccount:
			overrides.verifyAccount || (async () => ({ ok: true, at: "fresh-at" })),
	});
}

export function mutationCounts(result) {
	return {
		processed: result.processed,
		changed: result.changed,
		unchanged: result.unchanged,
		failed: result.failed,
	};
}
