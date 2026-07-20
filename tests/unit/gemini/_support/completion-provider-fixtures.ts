import type { RuntimeConfig } from "../../../../src/config";
import type { GeminiCompletionProviderOptions } from "../../../../src/gemini/completion-provider";
import type { ResolvedModelOk } from "../../../../src/models";
import { baseGeminiClientConfig } from "./client-fixtures.js";

type ClientOverrides = NonNullable<GeminiCompletionProviderOptions["client"]>;
type UploadOverrides = NonNullable<GeminiCompletionProviderOptions["uploads"]>;

export function flashModel(extended = false): ResolvedModelOk {
	return {
		name: extended ? "gemini-3.5-flash-extended" : "gemini-3.5-flash",
		family: "flash",
		extended,
		dynamicProviderId: null,
	};
}

export function proModel(extended = false): ResolvedModelOk {
	return {
		name: extended ? "gemini-3.1-pro-extended" : "gemini-3.1-pro",
		family: "pro",
		extended,
		dynamicProviderId: null,
	};
}

export function accountConfig(
	accountId: string,
	base: RuntimeConfig = baseGeminiClientConfig(),
): RuntimeConfig {
	return {
		...base,
		cookie: `__Secure-1PSID=psid-${accountId}`,
		gemini_account: {
			accountId,
			cookieHash: `hash-${accountId}`,
		},
	};
}

export function requireItem<T>(items: readonly T[], index = 0): T {
	const item = items[index];
	if (item === undefined) throw new Error(`expected item at index ${index}`);
	return item;
}

export function requireAccount(config: RuntimeConfig) {
	const account = config.gemini_account;
	if (!account) throw new Error("expected Gemini account context");
	return account;
}

export function errorRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object") {
		throw new Error("expected an error object");
	}
	return value as Record<string, unknown>;
}

export async function captureError(
	run: () => unknown | PromiseLike<unknown>,
): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected rejection");
}

export function failFastClient(
	overrides: Partial<ClientOverrides> = {},
): ClientOverrides {
	return {
		async generate() {
			throw new Error("unexpected client.generate call");
		},
		async generateRich() {
			throw new Error("unexpected client.generateRich call");
		},
		generateStream() {
			throw new Error("unexpected client.generateStream call");
		},
		...overrides,
	};
}

export function failFastUploads(
	overrides: Partial<UploadOverrides> = {},
): UploadOverrides {
	return {
		async resolveAttachments() {
			throw new Error("unexpected uploads.resolveAttachments call");
		},
		async uploadTextFile() {
			throw new Error("unexpected uploads.uploadTextFile call");
		},
		...overrides,
	};
}
