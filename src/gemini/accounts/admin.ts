import type { RuntimeConfig, WorkerEnv } from "../../config";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import type { UnknownRecord } from "../../shared/types";
import type { GeminiPublicFamily } from "../../models";
import type { GeminiAccountAdminFilterInput } from "./admin-input";
import {
	createInputFromAccount,
	GeminiAccountAdminError,
	hasAccountUpdate,
	normalizeBulkAction,
	normalizeCreateAccounts,
	normalizeListFilter,
	normalizeModelRoutePriority,
	updateFromBody,
	WORKER_ACCOUNT_IMPORT_MAX_ACCOUNTS,
} from "./admin-input";
import { rotateGeminiAccountCookie } from "./cookie-rotator";
import { type GeminiRouteTuple, geminiRouteKey } from "./routes";
import { verifyGeminiAccount } from "./probe";
import {
	identityHashFromCookie,
	normalizeGeminiCookieHeader,
	sha256Hex,
} from "./normalize";
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
	GeminiAccountVerifier,
	GeminiAccountMutationError,
	GeminiAccountMutationResult,
	GeminiAccountRefreshReason,
	GeminiAccountRuntimeStore,
	GeminiAccountStore,
	GeminiModelRoutingOverview,
} from "./types";

export { GeminiAccountAdminError } from "./admin-input";

export type GeminiAccountAdminServiceOptions = {
	store?: GeminiAccountStore;
	adminStore?: GeminiAccountAdminStore;
	runtimeStore?: GeminiAccountRuntimeStore;
	cfg: RuntimeConfig;
	nowMs?: () => number;
	rotateCookie?: GeminiAccountCookieRotator;
	verifyAccount?: GeminiAccountVerifier;
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
			verifyAccount: options.verifyAccount || verifyGeminiAccount,
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

	modelRoutingOverview(): Promise<GeminiModelRoutingOverview> {
		return this.pool.modelRoutingOverview(this.capabilityFreshAfterMs());
	}

	async replaceModelRoutePriority(
		family: GeminiPublicFamily,
		body: UnknownRecord,
	): Promise<GeminiModelRoutingOverview> {
		const routes = normalizeModelRoutePriority(body);
		await this.assertKnownModelRoutes(family, routes);
		if (!this.runtimeStore.replaceModelRoutePriority)
			throw new GeminiAccountAdminError(
				503,
				"model_routing_store_unavailable",
				"model routing store is unavailable",
			);
		await this.runtimeStore.replaceModelRoutePriority(
			family,
			routes,
			this.nowMs(),
		);
		this.pool.invalidateSnapshot();
		return this.modelRoutingOverview();
	}

	async clearModelRoutePriority(
		family: GeminiPublicFamily,
	): Promise<GeminiModelRoutingOverview> {
		if (!this.runtimeStore.clearModelRoutePriority)
			throw new GeminiAccountAdminError(
				503,
				"model_routing_store_unavailable",
				"model routing store is unavailable",
			);
		await this.runtimeStore.clearModelRoutePriority(family, this.nowMs());
		this.pool.invalidateSnapshot();
		return this.modelRoutingOverview();
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
			const identityHash = await identityHashFromCookie(input.cookieHeader);
			input.identityHash = identityHash;
			orderedCookieHashes.push(cookieHash);
			uniqueEntries.set(identityHash, { cookieHash, identityHash, input });
		}

		const entries = Array.from(uniqueEntries.values());
		const stored = this.adminStore.createAccountsBulk
			? await this.adminStore.createAccountsBulk(entries)
			: await createAccountsOneByOne(this.adminStore, entries, nowMs);
		const changed = stored.addedCookieHashes.size;
		const result = mutationResult(orderedCookieHashes.length, changed, [], 0);
		const createdAccountIds = entries.flatMap((entry) => {
			if (!stored.addedCookieHashes.has(entry.cookieHash)) return [];
			const item = stored.itemsByCookieHash.get(entry.cookieHash);
			return item ? [item.id] : [];
		});
		await this.scheduleImportedAccountProbes(createdAccountIds);
		return result;
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

	private capabilityFreshAfterMs(): number {
		return (
			this.nowMs() -
			Math.max(Number(this.cfg.gemini_account_capability_ttl_sec) || 3600, 60) *
				1000
		);
	}

	private async assertKnownModelRoutes(
		family: GeminiPublicFamily,
		routes: readonly GeminiRouteTuple[],
	): Promise<void> {
		const overview = await this.modelRoutingOverview();
		const known = overview.families.find((item) => item.family === family);
		const knownKeys = new Set((known?.routes || []).map(geminiRouteKey));
		for (const route of routes) {
			if (knownKeys.has(geminiRouteKey(route))) continue;
			throw new GeminiAccountAdminError(
				400,
				"unknown_model_route",
				"model routing policy contains an undiscovered route",
			);
		}
	}

	private async scheduleImportedAccountProbes(
		accountIds: readonly string[],
	): Promise<void> {
		const uniqueIds = [...new Set(accountIds)];
		if (!uniqueIds.length) return;
		const probes = mapWithConcurrency(uniqueIds, 4, async (id) => {
			try {
				const account = await this.runtimeStore.getAccountForRefresh(id);
				if (!account) return;
				const result = await this.pool.refreshAccountForAdmin(
					this.cfg,
					account,
					"import",
				);
				if (isRefreshFailure(result.reason))
					log(
						this.cfg,
						`post-import account probe incomplete accountId=${id} reason=${result.reason}`,
					);
			} catch (error) {
				log(
					this.cfg,
					`post-import account probe failed accountId=${id} ${errorLogSummary(error)}`,
				);
			}
		});
		if (!this.cfg.execution_ctx) {
			await probes;
			return;
		}
		try {
			this.cfg.execution_ctx.waitUntil(probes);
		} catch (error) {
			log(
				this.cfg,
				`post-import account probe waitUntil registration failed ${errorLogSummary(error)}`,
			);
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
		const existing = store.findAccountByIdentityHash
			? await store.findAccountByIdentityHash(entry.identityHash, nowMs)
			: await store.findAccountByCookieHash(entry.cookieHash, nowMs);
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
		reason === "rotation_duplicate" ||
		reason === "missing_page_at_token" ||
		reason === "status_probe_failed" ||
		reason === "status_restricted"
	);
}

function refreshFailureMessage(reason: GeminiAccountRefreshReason): string {
	if (reason === "missing_secure_1psid") return "account cookie is incomplete";
	if (reason === "account_missing") return "account not found";
	if (reason === "rotation_rejected") return "account refresh was rejected";
	if (reason === "rotation_duplicate")
		return "refreshed cookie belongs to another account";
	if (reason === "missing_page_at_token")
		return "Gemini session bootstrap did not return an auth token";
	if (reason === "status_probe_failed")
		return "Gemini account status probe failed";
	if (reason === "status_restricted")
		return "Gemini account status restricts access";
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
