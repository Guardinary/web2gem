import { accountResourcePath, mergeMutationResults } from "./logic";
import { parseMutation, parseOverview } from "./schemas";
import type {
	AccountAction,
	AccountIdentifier,
	AccountOverview,
	GeminiAccountState,
	MutationResult,
} from "./types";

const API_PATH = "/admin/accounts";
const WORKER_ACCOUNT_IMPORT_BATCH_SIZE = 40;
const WORKER_ACCOUNT_IMPORT_LIMIT_CODE = "gemini_import_account_limit_exceeded";
const BULK_ACTION_BATCH_SIZE = 100;
const BULK_ACTION_LIMIT_CODE = "admin_bulk_action_limit_exceeded";

export class AdminApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | null,
	) {
		super(message);
		this.name = "AdminApiError";
	}
}

export type ListOptions = {
	adminKey: string;
	cursor?: string;
	q?: string;
	state?: GeminiAccountState | "";
};

export type CreateInput = { label?: string; psid: string; psidts: string };
export type CreateBatchInput = { accounts: CreateInput[] };
export type UpdateInput = { id: string; label: string | null };

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

export async function getAccountOverview(
	options: ListOptions,
): Promise<AccountOverview> {
	const params = new URLSearchParams({ limit: "200" });
	if (options.cursor) params.set("cursor", options.cursor);
	if (options.q) params.set("q", options.q);
	if (options.state) params.set("state", options.state);
	return parseOverview(
		await request(options.adminKey, `${API_PATH}?${params.toString()}`),
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
				accounts: input.accounts.map((account) => ({
					provider: "gemini",
					"__Secure-1PSID": account.psid,
					"__Secure-1PSIDTS": account.psidts,
					...(account.label ? { label: account.label } : {}),
				})),
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
		)
			throw error;
	}
	const results: MutationResult[] = [];
	for (
		let offset = 0;
		offset < input.accounts.length;
		offset += WORKER_ACCOUNT_IMPORT_BATCH_SIZE
	)
		results.push(
			await createAccounts(adminKey, {
				accounts: input.accounts.slice(
					offset,
					offset + WORKER_ACCOUNT_IMPORT_BATCH_SIZE,
				),
			}),
		);
	return mergeMutationResults(results);
}

export async function updateAccount(
	adminKey: string,
	input: UpdateInput,
): Promise<MutationResult> {
	return parseMutation(
		await request(adminKey, accountResourcePath(input.id), {
			method: "PATCH",
			body: { label: input.label },
		}),
	);
}

export async function runAccountAction(
	adminKey: string,
	action: AccountAction,
	identifiers: AccountIdentifier[],
): Promise<MutationResult> {
	if (!identifiers.length)
		return { processed: 0, changed: 0, unchanged: 0, failed: 0 };
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
	action: AccountAction,
	identifiers: AccountIdentifier[],
): Promise<MutationResult> {
	return parseMutation(
		await request(adminKey, `${API_PATH}/actions`, {
			method: "POST",
			body: { action, ids: identifiers.map(({ id }) => id) },
		}),
	);
}
