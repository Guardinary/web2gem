import type { RuntimeConfig, WorkerEnv } from "../../config";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import type { UnknownRecord } from "../../shared/types";
import type { GeminiAccountAdminFilterInput } from "./admin-input";
import {
	createInputFromAccount,
	GeminiAccountAdminError,
	hasAccountUpdate,
	normalizeBulkAction,
	normalizeCreateAccounts,
	normalizeListFilter,
	updateFromBody,
	WORKER_ACCOUNT_IMPORT_MAX_ACCOUNTS,
} from "./admin-input";
import { rotateGeminiAccountCookie } from "./cookie-rotator";
import { normalizeGeminiCookieHeader, sha256Hex } from "./normalize";
import { AccountPoolService } from "./pool";
import { d1BindingFromEnv } from "./runtime";
import { D1GeminiAccountStore, isD1UniqueConstraintError } from "./store-d1";
import type {
	D1DatabaseLike,
	GeminiAccountAdminOverview,
	GeminiAccountAdminStore,
	GeminiAccountBulkCreateEntry,
	GeminiAccountBulkCreateResult,
	GeminiAccountCookieRotator,
	GeminiAccountMutationError,
	GeminiAccountMutationResult,
	GeminiAccountRefreshReason,
	GeminiAccountRuntimeStore,
	GeminiAccountStore,
} from "./types";

export { GeminiAccountAdminError } from "./admin-input";

export type GeminiAccountAdminServiceOptions = {
	store?: GeminiAccountStore;
	adminStore?: GeminiAccountAdminStore;
	runtimeStore?: GeminiAccountRuntimeStore;
	cfg: RuntimeConfig;
	nowMs?: () => number;
	rotateCookie?: GeminiAccountCookieRotator;
	maxCreateAccounts?: number | null;
};

type GeminiAccountAdminFactoryOptions = Partial<
	Omit<
		GeminiAccountAdminServiceOptions,
		"store" | "adminStore" | "runtimeStore" | "cfg"
	>
>;

type MutationOutcome =
	| { changed: true }
	| { changed: false; error?: GeminiAccountMutationError };

export class GeminiAccountAdminService {
	private readonly adminStore: GeminiAccountAdminStore;
	private readonly runtimeStore: GeminiAccountRuntimeStore;
	private readonly cfg: RuntimeConfig;
	private readonly nowMs: () => number;
	private readonly pool: AccountPoolService;
	private readonly maxCreateAccounts: number | null;

	constructor(options: GeminiAccountAdminServiceOptions) {
		const adminStore = options.adminStore || options.store;
		const runtimeStore = options.runtimeStore || options.store;
		if (!adminStore || !runtimeStore)
			throw new Error("Gemini account admin stores are required");
		this.adminStore = adminStore;
		this.runtimeStore = runtimeStore;
		this.cfg = options.cfg;
		this.nowMs = options.nowMs || Date.now;
		this.maxCreateAccounts =
			options.maxCreateAccounts === undefined
				? options.cfg.runtime_profile === "docker"
					? null
					: WORKER_ACCOUNT_IMPORT_MAX_ACCOUNTS
				: options.maxCreateAccounts;
		this.pool = new AccountPoolService(this.runtimeStore, {
			nowMs: this.nowMs,
			snapshotTtlMs: 1,
			versionProbeTtlMs: 1,
			selectableLimit: 200,
			rotateCookie: options.rotateCookie || rotateGeminiAccountCookie,
		});
	}

	overview(
		filter: GeminiAccountAdminFilterInput,
	): Promise<GeminiAccountAdminOverview> {
		return this.adminStore.getAdminOverview(
			normalizeListFilter(filter),
			this.nowMs(),
		);
	}

	async create(body: UnknownRecord): Promise<GeminiAccountMutationResult> {
		const accounts = normalizeCreateAccounts(body, this.maxCreateAccounts);
		const nowMs = this.nowMs();
		const uniqueEntries = new Map<string, GeminiAccountBulkCreateEntry>();
		const orderedCookieHashes: string[] = [];
		for (const account of accounts) {
			const input = createInputFromAccount(account, nowMs);
			const cookieHash = await sha256Hex(
				normalizeGeminiCookieHeader(input.cookieHeader),
			);
			orderedCookieHashes.push(cookieHash);
			if (!uniqueEntries.has(cookieHash))
				uniqueEntries.set(cookieHash, { cookieHash, input });
		}

		const entries = Array.from(uniqueEntries.values());
		const stored = this.adminStore.createAccountsBulk
			? await this.adminStore.createAccountsBulk(entries)
			: await createAccountsOneByOne(this.adminStore, entries, nowMs);
		const changed = stored.addedCookieHashes.size;
		return mutationResult(orderedCookieHashes.length, changed, [], 0);
	}

	async update(
		id: string,
		body: UnknownRecord,
	): Promise<GeminiAccountMutationResult> {
		const update = updateFromBody(body, this.nowMs());
		if (!hasAccountUpdate(update))
			throw new GeminiAccountAdminError(
				400,
				"account_update_required",
				"no account update fields provided",
			);
		const result = await this.adminStore.updateAccount(id, update);
		if (!result.item) return mutationResult(1, 0, [accountNotFoundError(id)]);
		return mutationResult(1, result.changed ? 1 : 0);
	}

	async delete(id: string): Promise<GeminiAccountMutationResult> {
		const changed = await this.adminStore.deleteAccount(id, this.nowMs());
		return changed
			? mutationResult(1, 1)
			: mutationResult(1, 0, [accountNotFoundError(id)]);
	}

	async runBulkAction(
		body: UnknownRecord,
	): Promise<GeminiAccountMutationResult> {
		const { action, ids } = normalizeBulkAction(body);
		const nowMs = this.nowMs();
		const outcomes = await mapWithConcurrency(ids, 4, async (id) => {
			if (action === "refresh") return this.refreshOne(id);
			if (action === "delete") {
				return (await this.adminStore.deleteAccount(id, nowMs))
					? { changed: true }
					: { changed: false, error: accountNotFoundError(id) };
			}
			const result = await this.adminStore.updateAccount(id, {
				enabled: action === "enable",
				nowMs,
			});
			if (!result.item)
				return { changed: false, error: accountNotFoundError(id) };
			return { changed: result.changed };
		});
		return mutationResultFromOutcomes(outcomes);
	}

	async refresh(id: string): Promise<GeminiAccountMutationResult> {
		return mutationResultFromOutcomes([await this.refreshOne(id)]);
	}

	private async refreshOne(id: string): Promise<MutationOutcome> {
		const account = await this.runtimeStore.getAccountForRefresh(id);
		if (!account) return { changed: false, error: accountNotFoundError(id) };
		try {
			const refresh = await this.pool.refreshAccountForAdmin(this.cfg, account);
			if (refresh.changed) return { changed: true };
			if (isRefreshFailure(refresh.reason)) {
				return {
					changed: false,
					error: {
						id,
						code: refresh.reason,
						message: refreshFailureMessage(refresh.reason),
					},
				};
			}
			return { changed: false };
		} catch (error) {
			log(
				this.cfg,
				`admin account refresh failed id=${id} ${errorLogSummary(error)}`,
			);
			return {
				changed: false,
				error: {
					id,
					code: "account_refresh_failed",
					message: "account refresh failed",
				},
			};
		}
	}
}

async function createAccountsOneByOne(
	store: GeminiAccountAdminStore,
	entries: GeminiAccountBulkCreateEntry[],
	nowMs: number,
): Promise<GeminiAccountBulkCreateResult> {
	const itemsByCookieHash = new Map();
	const addedCookieHashes = new Set<string>();
	for (const entry of entries) {
		const existing = await store.findAccountByCookieHash(
			entry.cookieHash,
			nowMs,
		);
		if (existing) {
			itemsByCookieHash.set(entry.cookieHash, existing);
			continue;
		}
		try {
			const created = await store.createAccount(entry.input);
			itemsByCookieHash.set(entry.cookieHash, created);
			addedCookieHashes.add(entry.cookieHash);
		} catch (error) {
			if (!isD1UniqueConstraintError(error)) throw error;
			const duplicate = await store.findAccountByCookieHash(
				entry.cookieHash,
				nowMs,
			);
			if (!duplicate) throw error;
			itemsByCookieHash.set(entry.cookieHash, duplicate);
		}
	}
	return { itemsByCookieHash, addedCookieHashes };
}

export function createGeminiAccountAdminServiceFromEnv(
	env: WorkerEnv | null | undefined,
	cfg: RuntimeConfig,
	options: GeminiAccountAdminFactoryOptions = {},
): GeminiAccountAdminService {
	const db = d1BindingFromEnv(env);
	if (!db)
		throw new GeminiAccountAdminError(
			503,
			"gemini_account_store_unavailable",
			"Gemini account D1 binding is not configured",
		);
	return createGeminiAccountAdminServiceFromD1(db, cfg, options);
}

export function createGeminiAccountAdminServiceFromD1(
	db: D1DatabaseLike,
	cfg: RuntimeConfig,
	options: GeminiAccountAdminFactoryOptions = {},
): GeminiAccountAdminService {
	const store = new D1GeminiAccountStore(db);
	return new GeminiAccountAdminService({
		...options,
		adminStore: store,
		cfg,
		runtimeStore: store,
	});
}

function mutationResultFromOutcomes(
	outcomes: readonly MutationOutcome[],
): GeminiAccountMutationResult {
	const changed = outcomes.filter((outcome) => outcome.changed).length;
	const errors = outcomes.flatMap((outcome) =>
		!outcome.changed && outcome.error ? [outcome.error] : [],
	);
	return mutationResult(outcomes.length, changed, errors);
}

function mutationResult(
	processed: number,
	changed: number,
	errors: GeminiAccountMutationError[] = [],
	failed = errors.length,
): GeminiAccountMutationResult {
	const result: GeminiAccountMutationResult = {
		processed,
		changed,
		unchanged: processed - changed - failed,
		failed,
	};
	if (errors.length) result.errors = errors;
	return result;
}

function accountNotFoundError(id: string): GeminiAccountMutationError {
	return { id, code: "account_not_found", message: "account not found" };
}

function isRefreshFailure(reason: GeminiAccountRefreshReason): boolean {
	return (
		reason === "missing_secure_1psid" ||
		reason === "account_missing" ||
		reason === "rotation_rejected" ||
		reason === "rotation_failed" ||
		reason === "rotation_duplicate"
	);
}

function refreshFailureMessage(reason: GeminiAccountRefreshReason): string {
	if (reason === "missing_secure_1psid") return "account cookie is incomplete";
	if (reason === "account_missing") return "account not found";
	if (reason === "rotation_rejected") return "account refresh was rejected";
	if (reason === "rotation_duplicate")
		return "refreshed cookie belongs to another account";
	return "account refresh failed";
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex++;
				results[index] = await worker(items[index] as T);
			}
		}),
	);
	return results;
}
