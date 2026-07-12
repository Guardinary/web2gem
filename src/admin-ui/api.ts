import { parseMutation, parseOverview, parsePage, parseStats } from "./schemas";
import { accountResourcePath, mergeMutationResults } from "./logic";
import type {
	AccountIdentifier,
	AccountOverview,
	AccountPage,
	AccountStats,
	MutationResult,
} from "./types";

const API_PATH = "/admin/accounts";
const WORKER_ACCOUNT_IMPORT_BATCH_SIZE = 40;
const WORKER_ACCOUNT_IMPORT_LIMIT_CODE = "gemini_import_account_limit_exceeded";
const BULK_ACTION_BATCH_SIZE = 100;
const BULK_ACTION_LIMIT_CODE = "admin_bulk_action_limit_exceeded";

export class AdminApiError extends Error {
	readonly status: number;
	readonly code: string | null;

	constructor(message: string, status: number, code: string | null) {
		super(message);
		this.name = "AdminApiError";
		this.status = status;
		this.code = code;
	}
}

export type ListOptions = {
	adminKey: string;
	cursor?: string;
	status?: string;
	enabled?: string;
	q?: string;
	category?: string;
	cooldown?: string;
	source?: string;
};

export type CreateInput = {
	label?: string;
	psid: string;
	psidts: string;
};

export type CreateBatchInput = {
	accounts: CreateInput[];
};

export type UpdateInput = {
	id: string;
	label: string | null;
	status: string;
	enabled: boolean;
	state_reason: string | null;
	source: string | null;
	source_name: string | null;
};

function headers(adminKey: string, json: boolean): HeadersInit {
	const normalized = adminKey.trim();
	if (!normalized) throw new Error("Admin key is required");
	return json
		? {
				Authorization: `Bearer ${normalized}`,
				"Content-Type": "application/json",
			}
		: { Authorization: `Bearer ${normalized}` };
}

async function request(
	adminKey: string,
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
	const hasBody = Object.hasOwn(init, "body");
	const requestInit: RequestInit = {
		method: init.method || "GET",
		headers: headers(adminKey, hasBody),
	};
	if (hasBody) requestInit.body = JSON.stringify(init.body ?? {});
	const response = await fetch(path, requestInit);
	const contentType = response.headers.get("content-type") || "";
	const body = contentType.includes("application/json")
		? await response.json()
		: await response.text();
	if (!response.ok) {
		const error = responseError(body);
		throw new AdminApiError(
			error.message || `Request failed with status ${response.status}`,
			response.status,
			error.code,
		);
	}
	return body;
}

function responseError(body: unknown): {
	message: string;
	code: string | null;
} {
	if (!body || typeof body !== "object" || !("error" in body))
		return { message: "", code: null };
	const error = body.error;
	if (!error || typeof error !== "object") return { message: "", code: null };
	const message =
		"message" in error && typeof error.message === "string"
			? error.message
			: "";
	const code =
		"code" in error && typeof error.code === "string" ? error.code : null;
	return { message: message || code || "", code };
}

export async function listAccounts(options: ListOptions): Promise<AccountPage> {
	const params = listParams(options);
	return parsePage(
		await request(options.adminKey, `${API_PATH}?${params.toString()}`),
	);
}

export async function getAccountOverview(
	options: ListOptions,
): Promise<AccountOverview> {
	const params = listParams(options);
	params.set("include_stats", "true");
	return parseOverview(
		await request(options.adminKey, `${API_PATH}?${params.toString()}`),
	);
}

function listParams(options: ListOptions): URLSearchParams {
	const params = new URLSearchParams({ limit: "200" });
	if (options.cursor) params.set("cursor", options.cursor);
	if (options.status) params.set("status", options.status);
	if (options.enabled) params.set("enabled", options.enabled);
	if (options.q) params.set("q", options.q);
	if (options.category) params.set("category", options.category);
	if (options.cooldown) params.set("cooldown", options.cooldown);
	if (options.source) params.set("source", options.source);
	return params;
}

export async function getAccountStats(
	options: ListOptions,
): Promise<AccountStats> {
	const params = new URLSearchParams();
	if (options.status) params.set("status", options.status);
	if (options.enabled) params.set("enabled", options.enabled);
	if (options.q) params.set("q", options.q);
	if (options.category) params.set("category", options.category);
	if (options.cooldown) params.set("cooldown", options.cooldown);
	if (options.source) params.set("source", options.source);
	return parseStats(
		await request(options.adminKey, `${API_PATH}/stats?${params.toString()}`),
	);
}

export async function createAccount(
	adminKey: string,
	input: CreateInput,
): Promise<MutationResult> {
	const payload: Record<string, string> = {
		provider: "gemini",
		"__Secure-1PSID": input.psid,
		"__Secure-1PSIDTS": input.psidts,
	};
	if (input.label) payload.label = input.label;
	return parseMutation(
		await request(adminKey, API_PATH, { method: "POST", body: payload }),
	);
}

export async function createAccounts(
	adminKey: string,
	input: CreateBatchInput,
): Promise<MutationResult> {
	return parseMutation(
		await request(adminKey, API_PATH, {
			method: "POST",
			body: {
				provider: "gemini",
				accounts: input.accounts.map((account) => {
					const payload: Record<string, string> = {
						provider: "gemini",
						"__Secure-1PSID": account.psid,
						"__Secure-1PSIDTS": account.psidts,
					};
					if (account.label) payload.label = account.label;
					return payload;
				}),
			},
		}),
	);
}

export async function createAccountsWithLimitFallback(
	adminKey: string,
	input: CreateBatchInput,
): Promise<MutationResult> {
	try {
		return await createAccounts(adminKey, input);
	} catch (error) {
		if (
			!(error instanceof AdminApiError) ||
			error.status !== 413 ||
			error.code !== WORKER_ACCOUNT_IMPORT_LIMIT_CODE ||
			input.accounts.length <= WORKER_ACCOUNT_IMPORT_BATCH_SIZE
		) {
			throw error;
		}
	}

	const results: MutationResult[] = [];
	for (
		let offset = 0;
		offset < input.accounts.length;
		offset += WORKER_ACCOUNT_IMPORT_BATCH_SIZE
	) {
		results.push(
			await createAccounts(adminKey, {
				accounts: input.accounts.slice(
					offset,
					offset + WORKER_ACCOUNT_IMPORT_BATCH_SIZE,
				),
			}),
		);
	}
	return mergeMutationResults(results);
}

export async function updateAccount(
	adminKey: string,
	input: UpdateInput,
): Promise<MutationResult> {
	const { id, ...patch } = input;
	return parseMutation(
		await request(adminKey, accountResourcePath(id), {
			method: "PATCH",
			body: patch,
		}),
	);
}

export async function runAccountAction(
	adminKey: string,
	action: string,
	identifiers: AccountIdentifier[],
): Promise<MutationResult> {
	if (!identifiers.length) return {};
	try {
		return await requestBulkAccountAction(adminKey, action, identifiers);
	} catch (error) {
		if (
			!(error instanceof AdminApiError) ||
			error.status !== 413 ||
			error.code !== BULK_ACTION_LIMIT_CODE ||
			identifiers.length <= BULK_ACTION_BATCH_SIZE
		)
			throw error;
	}
	const results: MutationResult[] = [];
	for (
		let offset = 0;
		offset < identifiers.length;
		offset += BULK_ACTION_BATCH_SIZE
	)
		results.push(
			await requestBulkAccountAction(
				adminKey,
				action,
				identifiers.slice(offset, offset + BULK_ACTION_BATCH_SIZE),
			),
		);
	return mergeMutationResults(results);
}

async function requestBulkAccountAction(
	adminKey: string,
	action: string,
	identifiers: AccountIdentifier[],
): Promise<MutationResult> {
	return parseMutation(
		await request(adminKey, `${API_PATH}/actions`, {
			method: "POST",
			body: { action, ids: identifiers.map(({ id }) => id) },
		}),
	);
}
