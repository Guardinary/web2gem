import type { RuntimeConfig, WorkerEnv } from "../../config";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import type { UnknownRecord } from "../../shared/types";
import {
	createInputFromAccount,
	GeminiAccountAdminError,
	hasAccountUpdate,
	normalizeCreateAccounts,
	normalizeBulkAction,
	normalizeListFilter,
	updateFromBody,
	WORKER_ACCOUNT_IMPORT_MAX_ACCOUNTS,
} from "./admin-input";
import type { GeminiAccountAdminFilterInput } from "./admin-input";
import { normalizeGeminiCookieHeader, sha256Hex } from "./normalize";
import { AccountPoolService } from "./pool";
import { d1BindingFromEnv } from "./runtime";
import { D1GeminiAccountStore, isD1UniqueConstraintError } from "./store-d1";
import type {
	D1DatabaseLike,
	GeminiAccountBulkCreateEntry,
	GeminiAccountBulkCreateResult,
	GeminiAccountAdminFilter,
	GeminiAccountAdminOverview,
	GeminiAccountAdminStats,
	GeminiAccountAdminStore,
	GeminiAccountCookieRotator,
	GeminiAccountPublic,
	GeminiAccountPublicPage,
	GeminiAccountRefreshResult,
	GeminiAccountRuntimeStore,
	GeminiAccountStore,
} from "./types";

export { GeminiAccountAdminError } from "./admin-input";

export type GeminiAccountMutationResult = {
	items: GeminiAccountPublic[];
	updated?: number;
	removed?: number;
	skipped?: number;
};

export type GeminiAccountBulkActionResult = GeminiAccountMutationResult & {
	checked?: number;
	refreshed?: number;
	unchanged?: number;
	failed?: number;
	errors: GeminiAccountDiagnosticError[];
	results: GeminiAccountDiagnosticItem[];
};

export type GeminiAccountCreateResult = {
	added: number;
	skipped: number;
	items: GeminiAccountPublic[];
	duplicates?: number;
};

export type GeminiAccountDiagnosticItem = {
	id?: string;
	row_id?: string;
	status: "refreshed" | "unchanged" | "failed" | "skipped";
	reason?: string;
	upstreamStatus?: number;
};

export type GeminiAccountDiagnosticError = {
	id?: string;
	row_id?: string;
	error: string;
};

export type GeminiAccountDiagnosticResult = {
	checked: number;
	skipped: number;
	refreshed: number;
	unchanged: number;
	failed: number;
	errors: GeminiAccountDiagnosticError[];
	results: GeminiAccountDiagnosticItem[];
	items: GeminiAccountPublic[];
};

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
		const poolOptions = {
			nowMs: this.nowMs,
			snapshotTtlMs: 1,
			versionProbeTtlMs: 1,
			selectableLimit: 200,
			...(options.rotateCookie ? { rotateCookie: options.rotateCookie } : {}),
		};
		this.pool = new AccountPoolService(this.runtimeStore, poolOptions);
	}

	list(
		filter: GeminiAccountAdminFilterInput,
	): Promise<GeminiAccountPublicPage> {
		return this.adminStore.listAdminAccounts(
			normalizeListFilter(filter),
			this.nowMs(),
		);
	}

	overview(
		filter: GeminiAccountAdminFilterInput,
	): Promise<GeminiAccountAdminOverview> {
		const normalized = normalizeListFilter(filter);
		const nowMs = this.nowMs();
		if (this.adminStore.getAdminOverview)
			return this.adminStore.getAdminOverview(normalized, nowMs);
		return Promise.all([
			this.adminStore.listAdminAccounts(normalized, nowMs),
			this.stats(normalized),
		]).then(([page, stats]) => ({ ...page, stats }));
	}

	stats(
		filter: GeminiAccountAdminFilterInput,
	): Promise<GeminiAccountAdminStats> {
		const nowMs = this.nowMs();
		const normalized = normalizeListFilter({ ...filter, limit: 1 });
		const statsFilter: Omit<GeminiAccountAdminFilter, "cursor" | "limit"> = {};
		if (normalized.status) statsFilter.status = normalized.status;
		if (normalized.enabled !== undefined)
			statsFilter.enabled = normalized.enabled;
		if (normalized.q) statsFilter.q = normalized.q;
		if (normalized.category) statsFilter.category = normalized.category;
		if (normalized.cooldown) statsFilter.cooldown = normalized.cooldown;
		if (normalized.source) statsFilter.source = normalized.source;
		return this.adminStore.getAdminStats(statsFilter, nowMs);
	}

	async create(body: UnknownRecord): Promise<GeminiAccountCreateResult> {
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
			: await createAccountsCompatibility(this.adminStore, entries);
		let added = 0;
		let skipped = 0;
		let duplicates = 0;
		const items: GeminiAccountPublic[] = [];
		const seen = new Set<string>();
		for (const cookieHash of orderedCookieHashes) {
			const item = stored.itemsByCookieHash.get(cookieHash);
			if (!item) throw new Error("account import result is incomplete");
			items.push(item);
			if (stored.addedCookieHashes.has(cookieHash) && !seen.has(cookieHash)) {
				added += 1;
			} else {
				skipped += 1;
				duplicates += 1;
			}
			seen.add(cookieHash);
		}
		return { added, skipped, duplicates, items };
	}

	async update(
		id: string,
		body: UnknownRecord,
	): Promise<GeminiAccountMutationResult> {
		const update = updateFromBody(body, this.nowMs());
		if (!hasAccountUpdate(update)) {
			throw new GeminiAccountAdminError(
				400,
				"account_update_required",
				"no account update fields provided",
			);
		}
		const item = await this.adminStore.updateAccount(id, update);
		if (!item) throw accountNotFound();
		return { updated: 1, skipped: 0, items: [item] };
	}

	async delete(id: string): Promise<GeminiAccountMutationResult> {
		if (!(await this.adminStore.deleteAccount(id))) throw accountNotFound();
		return { removed: 1, skipped: 0, items: [] };
	}

	async runBulkAction(
		body: UnknownRecord,
	): Promise<GeminiAccountBulkActionResult> {
		const { action, ids } = normalizeBulkAction(body);
		if (action === "refresh" || action === "check") {
			const outcomes = await mapWithConcurrency(ids, 4, (id) =>
				this.refreshOrCheckOne(id, action),
			);
			return diagnosticResult(
				outcomes.map((outcome) => outcome.item),
				outcomes.flatMap((outcome) => (outcome.error ? [outcome.error] : [])),
				[],
			);
		}
		if (action === "delete") {
			let removedIds: string[];
			if (this.adminStore.deleteAccountsBulk) {
				removedIds = await this.adminStore.deleteAccountsBulk(
					ids,
					this.nowMs(),
				);
			} else {
				const deleted = await Promise.all(
					ids.map((id) => this.adminStore.deleteAccount(id)),
				);
				removedIds = ids.filter((_id, index) => deleted[index]);
			}
			return bulkMutationResult(action, ids, removedIds, []);
		}
		const enabled = action === "enable";
		const items = this.adminStore.setAccountsEnabledBulk
			? await this.adminStore.setAccountsEnabledBulk(ids, enabled, this.nowMs())
			: (
					await Promise.all(
						ids.map((id) =>
							this.adminStore.updateAccount(id, {
								enabled,
								nowMs: this.nowMs(),
							}),
						),
					)
				).filter((item): item is GeminiAccountPublic => item !== null);
		return bulkMutationResult(
			action,
			ids,
			items.map((item) => item.id),
			items,
		);
	}

	async refresh(id: string): Promise<GeminiAccountDiagnosticResult> {
		return this.runDiagnostic(id, "refresh");
	}

	async check(id: string): Promise<GeminiAccountDiagnosticResult> {
		return this.runDiagnostic(id, "check");
	}

	private async runDiagnostic(
		id: string,
		mode: "refresh" | "check",
	): Promise<GeminiAccountDiagnosticResult> {
		const result = await this.refreshOrCheckOne(id, mode);
		if (result.item.reason === "account_missing") throw accountNotFound();
		return diagnosticResult(
			[result.item],
			result.error ? [result.error] : [],
			[],
		);
	}

	private async refreshOrCheckOne(
		id: string,
		mode: "refresh" | "check",
	): Promise<{
		item: GeminiAccountDiagnosticItem;
		error?: GeminiAccountDiagnosticError;
	}> {
		const account = await this.runtimeStore.getAccountForRefresh(id);
		const identity = account
			? { id: account.id, row_id: account.row_id }
			: { id };
		if (!account) {
			return {
				item: { ...identity, status: "skipped", reason: "account_missing" },
			};
		}
		if (account.enabled === 0) {
			return {
				item: { ...identity, status: "skipped", reason: "account_disabled" },
			};
		}
		if (
			account.account_category !== "full_session" &&
			account.account_category !== "psid_psidts"
		) {
			return {
				item: { ...identity, status: "skipped", reason: "not_refreshable" },
			};
		}
		try {
			const refresh = await this.pool.refreshAccountForAdmin(
				this.cfg,
				account,
				mode,
			);
			return { item: diagnosticItemFromRefresh(identity, refresh) };
		} catch (error) {
			log(
				this.cfg,
				`admin diagnostic error id=${id} mode=${mode} ${errorLogSummary(error)}`,
			);
			return {
				item: { ...identity, status: "failed", reason: "refresh_error" },
				error: { ...identity, error: safeAdminError(error) },
			};
		}
	}
}

async function createAccountsCompatibility(
	store: GeminiAccountAdminStore,
	entries: GeminiAccountBulkCreateEntry[],
): Promise<GeminiAccountBulkCreateResult> {
	const itemsByCookieHash = new Map<string, GeminiAccountPublic>();
	const addedCookieHashes = new Set<string>();
	for (const entry of entries) {
		const existing = await store.findAccountByCookieHash(entry.cookieHash);
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
			const duplicate = await store.findAccountByCookieHash(entry.cookieHash);
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

function diagnosticItemFromRefresh(
	identity: { id: string; row_id?: string },
	refresh: GeminiAccountRefreshResult,
): GeminiAccountDiagnosticItem {
	const item: GeminiAccountDiagnosticItem = {
		...identity,
		status: refresh.changed ? "refreshed" : "unchanged",
		reason: refresh.reason,
	};
	if (refresh.upstreamStatus !== undefined)
		item.upstreamStatus = refresh.upstreamStatus;
	return item;
}

function diagnosticResult(
	results: GeminiAccountDiagnosticItem[],
	errors: GeminiAccountDiagnosticError[],
	items: GeminiAccountPublic[],
): GeminiAccountDiagnosticResult {
	let skipped = 0;
	let refreshed = 0;
	let unchanged = 0;
	let failed = 0;
	for (const result of results) {
		if (result.status === "skipped") skipped++;
		else if (result.status === "refreshed") refreshed++;
		else if (result.status === "unchanged") unchanged++;
		else if (result.status === "failed") failed++;
	}
	return {
		checked: results.length,
		skipped,
		refreshed,
		unchanged,
		failed,
		errors,
		results: results.sort((a, b) =>
			String(a.id || "").localeCompare(String(b.id || "")),
		),
		items,
	};
}

function bulkMutationResult(
	action: "enable" | "disable" | "delete",
	ids: readonly string[],
	changedIdsInput: readonly string[],
	items: GeminiAccountPublic[],
): GeminiAccountBulkActionResult {
	const changedIds = new Set(
		action === "delete" ? changedIdsInput : items.map((item) => item.id),
	);
	const results: GeminiAccountDiagnosticItem[] = ids.map((id) => ({
		id,
		status: changedIds.has(id) ? "refreshed" : "skipped",
		...(!changedIds.has(id) ? { reason: "account_missing" } : {}),
	}));
	const changed = changedIds.size;
	return {
		items,
		...(action === "delete" ? { removed: changed } : { updated: changed }),
		skipped: ids.length - changed,
		errors: [],
		results,
	};
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

function safeAdminError(error: unknown): string {
	if (error instanceof GeminiAccountAdminError) return error.code;
	return "admin_diagnostic_failed";
}

function accountNotFound(): GeminiAccountAdminError {
	return new GeminiAccountAdminError(
		404,
		"account_not_found",
		"account not found",
	);
}
