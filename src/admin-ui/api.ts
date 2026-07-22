import {
	parseModelRoutingOverview,
	parseMutation,
	parseOverview,
} from "./schemas";
import type {
	AccountAction,
	AccountIdentifier,
	AccountOverview,
	GeminiAccountState,
	ModelFamily,
	ModelRoutingOverview,
	ModelRouteTuple,
	MutationResult,
} from "./types";

const API_PATH = "/admin/accounts";
const MODEL_ROUTING_API_PATH = "/admin/model-routing";
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

export type AdminApiSession = {
	adminKey: string;
	signal: AbortSignal;
};

export type ListOptions = {
	cursor?: string;
	q?: string;
	state?: GeminiAccountState | "";
};

export type CreateInput = { label?: string; psid: string; psidts: string };
export type CreateBatchInput = { accounts: CreateInput[] };
export type UpdateInput = { id: string; label: string | null };

function accountResourcePath(id: string): string {
	return `${API_PATH}/${encodeURIComponent(id)}`;
}

function mergeMutationResults(
	results: readonly MutationResult[],
): MutationResult {
	const merged: MutationResult = {
		processed: 0,
		changed: 0,
		unchanged: 0,
		failed: 0,
	};
	for (const result of results) {
		merged.processed += result.processed;
		merged.changed += result.changed;
		merged.unchanged += result.unchanged;
		merged.failed += result.failed;
	}
	const errors = results.flatMap((result) => result.errors || []);
	if (errors.length) merged.errors = errors;
	return merged;
}

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
	session: AdminApiSession,
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
	assertAdminApiSessionActive(session);
	const hasBody = Object.hasOwn(init, "body");
	const requestInit: RequestInit = {
		method: init.method || "GET",
		headers: headers(session.adminKey, hasBody),
		signal: session.signal,
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

function assertAdminApiSessionActive(session: AdminApiSession): void {
	if (!session.signal.aborted) return;
	const error = new Error("Admin session is no longer active");
	error.name = "AbortError";
	throw error;
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
	session: AdminApiSession,
	options: ListOptions,
): Promise<AccountOverview> {
	const params = new URLSearchParams({ limit: "200" });
	if (options.cursor) params.set("cursor", options.cursor);
	if (options.q) params.set("q", options.q);
	if (options.state) params.set("state", options.state);
	return parseOverview(
		await request(session, `${API_PATH}?${params.toString()}`),
	);
}

export async function getModelRoutingOverview(
	session: AdminApiSession,
): Promise<ModelRoutingOverview> {
	return parseModelRoutingOverview(
		await request(session, MODEL_ROUTING_API_PATH),
	);
}

export async function replaceModelRoutePriority(
	session: AdminApiSession,
	family: ModelFamily,
	routes: readonly ModelRouteTuple[],
): Promise<ModelRoutingOverview> {
	return parseModelRoutingOverview(
		await request(session, `${MODEL_ROUTING_API_PATH}/${family}`, {
			method: "PUT",
			body: { routes },
		}),
	);
}

export async function resetModelRoutePriority(
	session: AdminApiSession,
	family: ModelFamily,
): Promise<ModelRoutingOverview> {
	return parseModelRoutingOverview(
		await request(session, `${MODEL_ROUTING_API_PATH}/${family}`, {
			method: "DELETE",
		}),
	);
}

export async function createAccount(
	session: AdminApiSession,
	input: CreateInput,
): Promise<MutationResult> {
	const payload: Record<string, string> = {
		provider: "gemini",
		"__Secure-1PSID": input.psid,
		"__Secure-1PSIDTS": input.psidts,
	};
	if (input.label) payload.label = input.label;
	return parseMutation(
		await request(session, API_PATH, { method: "POST", body: payload }),
	);
}

async function createAccounts(
	session: AdminApiSession,
	input: CreateBatchInput,
): Promise<MutationResult> {
	return parseMutation(
		await request(session, API_PATH, {
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
	session: AdminApiSession,
	input: CreateBatchInput,
): Promise<MutationResult> {
	return requestWithLimitFallback(
		input.accounts,
		WORKER_ACCOUNT_IMPORT_BATCH_SIZE,
		WORKER_ACCOUNT_IMPORT_LIMIT_CODE,
		(accounts) => createAccounts(session, { accounts: [...accounts] }),
	);
}

export async function updateAccount(
	session: AdminApiSession,
	input: UpdateInput,
): Promise<MutationResult> {
	return parseMutation(
		await request(session, accountResourcePath(input.id), {
			method: "PATCH",
			body: { label: input.label },
		}),
	);
}

export async function runAccountAction(
	session: AdminApiSession,
	action: AccountAction,
	identifiers: AccountIdentifier[],
): Promise<MutationResult> {
	if (!identifiers.length)
		return { processed: 0, changed: 0, unchanged: 0, failed: 0 };
	return requestWithLimitFallback(
		identifiers,
		BULK_ACTION_BATCH_SIZE,
		BULK_ACTION_LIMIT_CODE,
		(batch) => requestBulkAccountAction(session, action, [...batch]),
	);
}

async function requestWithLimitFallback<Item>(
	items: readonly Item[],
	chunkSize: number,
	limitCode: string,
	send: (items: readonly Item[]) => Promise<MutationResult>,
): Promise<MutationResult> {
	try {
		return await send(items);
	} catch (error) {
		if (
			!(error instanceof AdminApiError) ||
			error.status !== 413 ||
			error.code !== limitCode ||
			items.length <= chunkSize
		)
			throw error;
	}
	const results: MutationResult[] = [];
	for (let offset = 0; offset < items.length; offset += chunkSize) {
		results.push(await send(items.slice(offset, offset + chunkSize)));
	}
	return mergeMutationResults(results);
}

async function requestBulkAccountAction(
	session: AdminApiSession,
	action: AccountAction,
	identifiers: AccountIdentifier[],
): Promise<MutationResult> {
	return parseMutation(
		await request(session, `${API_PATH}/actions`, {
			method: "POST",
			body: { action, ids: identifiers.map(({ id }) => id) },
		}),
	);
}
