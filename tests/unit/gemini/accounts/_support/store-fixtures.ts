import { isDeepStrictEqual } from "node:util";
import type {
	GeminiAccountAdminStore,
	GeminiAccountSummary,
} from "../../../../../src/gemini/accounts/admin-types";
import type { GeminiAccountIssue } from "../../../../../src/gemini/accounts/domain";
import type { GeminiAccountRuntimeStore } from "../../../../../src/gemini/accounts/runtime-types";
import type {
	D1DatabaseLike,
	D1PreparedStatementLike,
	D1Result,
	GeminiAccountRow,
} from "../../../../../src/gemini/accounts/storage-types";
import type { GeminiAccountSummarySqlRow } from "../../../../../src/gemini/accounts/store-d1-admin";

type SqlExpectation = string | RegExp;
type D1Operation = "first" | "all" | "run" | "batch";

export type D1Expectation = {
	sql: SqlExpectation;
	binds: readonly unknown[];
	operation: D1Operation;
	result?: unknown;
	error?: unknown;
	columnName?: string;
};

export type RecordingD1Record = {
	sql: string;
	binds: unknown[] | null;
	operation: D1Operation | null;
};

export function accountSqlRow(
	id: string,
	overrides: Partial<GeminiAccountRow> = {},
): GeminiAccountRow {
	return {
		id,
		label: null,
		enabled: 1,
		cookie_header: `__Secure-1PSID=secret-p-${id}; __Secure-1PSIDTS=secret-t-${id}`,
		cookie_hash: `hash-${id}`,
		identity_hash: `identity-${id}`,
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
		account_status_code: null,
		status_checked_at_ms: null,
		last_refresh_attempt_at_ms: null,
		last_refresh_success_at_ms: null,
		created_at_ms: 1000,
		updated_at_ms: 1000,
		...overrides,
	};
}

export function accountSummary(
	id: string,
	overrides: Partial<GeminiAccountSummary> = {},
): GeminiAccountSummary {
	return {
		id,
		label: null,
		enabled: true,
		state: "available",
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
		status_checked_at_ms: null,
		last_refresh_success_at_ms: null,
		created_at_ms: 1000,
		updated_at_ms: 1000,
		...overrides,
	};
}

export function adminSqlRow(
	id: string,
	overrides: Partial<GeminiAccountSummarySqlRow> = {},
): GeminiAccountSummarySqlRow {
	const row = accountSqlRow(id, overrides);
	return {
		id: row.id,
		label: row.label,
		enabled: row.enabled,
		issue: row.issue,
		cooldown_until_ms: row.cooldown_until_ms,
		last_issue_at_ms: row.last_issue_at_ms,
		last_used_at_ms: row.last_used_at_ms,
		last_refresh_at_ms: row.last_refresh_at_ms,
		status_checked_at_ms: row.status_checked_at_ms,
		last_refresh_success_at_ms: row.last_refresh_success_at_ms,
		created_at_ms: row.created_at_ms,
		updated_at_ms: row.updated_at_ms,
	};
}

export const durableIssues = [
	"auth",
	"user_action",
	"location",
] as const satisfies readonly GeminiAccountIssue[];

const poolVersionSql = {
	changes:
		/INSERT INTO gemini_pool_meta .*SELECT \?, '1', \? WHERE changes\(\) > 0 ON CONFLICT\(key\) DO UPDATE SET/,
	insertedRows:
		/INSERT INTO gemini_pool_meta .*SELECT \?, '1', \? WHERE EXISTS \( SELECT 1 FROM gemini_accounts WHERE id IN \(.*\) \) ON CONFLICT\(key\) DO UPDATE SET/,
	unconditional:
		/INSERT INTO gemini_pool_meta .*SELECT \?, '1', \? ON CONFLICT\(key\) DO UPDATE SET/,
};

export function poolVersionExpectation(
	nowMs: number,
	mode: keyof typeof poolVersionSql = "changes",
	extraBinds: readonly unknown[] = [],
): D1Expectation {
	return {
		sql: poolVersionSql[mode],
		binds: ["pool_version", nowMs, ...extraBinds],
		operation: "batch",
		result: { meta: { changes: 1 } },
	};
}

export function mutationResult(changes = 1): D1Result {
	return { meta: { changes } };
}

export class RecordingD1 implements D1DatabaseLike {
	readonly pending: D1Expectation[];
	readonly records: RecordingD1Record[] = [];
	readonly batches: RecordingD1Record[][] = [];

	constructor(expectations: readonly D1Expectation[] = []) {
		this.pending = [...expectations];
	}

	prepare(sql: string): D1PreparedStatementLike {
		const expectation = this.pending.shift();
		if (!expectation)
			throw new Error(`unexpected D1 prepare: ${normalizeSql(sql)}`);
		const normalized = normalizeSql(sql);
		assertSql(expectation.sql, normalized);
		const record = { sql: normalized, binds: null, operation: null };
		this.records.push(record);
		return new RecordingStatement(this, expectation, record);
	}

	async batch<T = unknown>(
		statements: D1PreparedStatementLike[],
	): Promise<D1Result<T>[]> {
		if (!Array.isArray(statements))
			throw new Error("D1 batch must be an array");
		this.batches.push(
			statements.map((statement) => {
				if (!(statement instanceof RecordingStatement) || statement.db !== this)
					throw new Error("D1 batch received an unrecorded statement");
				return statement.record;
			}),
		);
		return statements.map((statement) => {
			if (!(statement instanceof RecordingStatement) || statement.db !== this)
				throw new Error("D1 batch received an unrecorded statement");
			return statement.execute<D1Result<T>>("batch");
		});
	}

	assertBatches(expectedRecordIndexes: readonly (readonly number[])[]): void {
		const actualRecordIndexes = this.batches.map((batch) =>
			batch.map((record) => this.records.indexOf(record)),
		);
		assertValues(expectedRecordIndexes, actualRecordIndexes, "D1 batch groups");
	}

	assertDrained(): void {
		if (this.pending.length) {
			throw new Error(
				`unconsumed D1 expectations: ${this.pending
					.map((item) => String(item.sql))
					.join(", ")}`,
			);
		}
		const incomplete = this.records.find((record) => record.operation === null);
		if (incomplete)
			throw new Error(
				`prepared D1 statement was not executed: ${incomplete.sql}`,
			);
	}

	get lastStatement(): RecordingD1Record | undefined {
		return this.records.at(-1);
	}
}

class RecordingStatement implements D1PreparedStatementLike {
	constructor(
		readonly db: RecordingD1,
		private readonly expectation: D1Expectation,
		readonly record: RecordingD1Record,
	) {}

	bind(...values: unknown[]): D1PreparedStatementLike {
		if (this.record.binds !== null)
			throw new Error(`D1 statement was bound twice: ${this.record.sql}`);
		assertValues(this.expectation.binds, values, this.record.sql);
		this.record.binds = values;
		return this;
	}

	async first<T = unknown>(columnName?: string): Promise<T | null> {
		if (this.expectation.columnName !== undefined)
			assertValues(
				[this.expectation.columnName],
				[columnName],
				`${this.record.sql} column`,
			);
		return this.execute<T | null>("first");
	}

	async all<T = unknown>(): Promise<D1Result<T>> {
		return this.execute<D1Result<T>>("all");
	}

	async run<T = unknown>(): Promise<D1Result<T>> {
		return this.execute<D1Result<T>>("run");
	}

	execute<T>(operation: D1Operation): T {
		if (this.record.operation !== null)
			throw new Error(`D1 statement executed twice: ${this.record.sql}`);
		if (this.record.binds === null) {
			assertValues(this.expectation.binds, [], this.record.sql);
			this.record.binds = [];
		}
		if (this.expectation.operation !== operation) {
			throw new Error(
				`unexpected D1 operation for ${this.record.sql}: expected ${this.expectation.operation}, received ${operation}`,
			);
		}
		this.record.operation = operation;
		if (Object.hasOwn(this.expectation, "error")) throw this.expectation.error;
		return this.expectation.result as T;
	}
}

const ACCOUNT_STORE_METHODS = [
	"getPoolVersion",
	"listSelectableAccounts",
	"getAccountForRefresh",
	"tryAcquireRefreshLock",
	"releaseRefreshLock",
	"writeRefreshedCookie",
	"writeAccountOutcome",
	"writeAccountProbe",
	"listAccountCapabilities",
	"listAllAccountCapabilities",
	"listModelRoutePriorities",
	"replaceModelRoutePriority",
	"clearModelRoutePriority",
	"getAdminOverview",
	"findAccountByCookieHash",
	"findAccountByIdentityHash",
	"createAccount",
	"importAccountByIdentity",
	"createAccountsBulk",
	"updateAccount",
	"deleteAccount",
	"setAccountsEnabledBulk",
	"deleteAccountsBulk",
] as const;

type CompleteAccountStore = Required<
	GeminiAccountAdminStore & GeminiAccountRuntimeStore
>;
type StoreMethod = {
	[K in keyof CompleteAccountStore]: CompleteAccountStore[K] extends (
		...args: infer _Args
	) => unknown
		? K
		: never;
}[keyof CompleteAccountStore];
type StoreMethodArgs<K extends StoreMethod> = CompleteAccountStore[K] extends (
	...args: infer Args
) => unknown
	? Args
	: never;
type StoreMethodResult<K extends StoreMethod> =
	CompleteAccountStore[K] extends (...args: never[]) => Promise<infer Result>
		? Result
		: never;
type StoreMethodExpectation<K extends StoreMethod> = {
	args?: StoreMethodArgs<K>;
	check?: (args: StoreMethodArgs<K>) => void;
	run?: (
		args: StoreMethodArgs<K>,
	) => StoreMethodResult<K> | Promise<StoreMethodResult<K>>;
	result?: StoreMethodResult<K>;
	error?: unknown;
};
type AccountStoreExpectations = {
	[K in StoreMethod]?: StoreMethodExpectation<K> | StoreMethodExpectation<K>[];
};
type AccountStoreCall = {
	method: StoreMethod;
	args: readonly unknown[];
};
type AccountStoreDouble = GeminiAccountAdminStore &
	GeminiAccountRuntimeStore & {
		calls: AccountStoreCall[];
		assertDrained(): void;
	};

export function createAccountStoreDouble(
	expectations: AccountStoreExpectations = {},
): AccountStoreDouble {
	const offsets = new Map<StoreMethod, number>();
	const calls: AccountStoreCall[] = [];

	async function invoke<K extends StoreMethod>(
		method: K,
		args: StoreMethodArgs<K>,
	): Promise<StoreMethodResult<K>> {
		const entries = expectationEntries(expectations[method]);
		const offset = offsets.get(method) ?? 0;
		const expectation = entries[offset];
		if (!expectation)
			throw new Error(`unexpected account store call: ${method}`);
		offsets.set(method, offset + 1);
		calls.push({ method, args });
		if (Object.hasOwn(expectation, "args"))
			assertValues(expectation.args, args, `account store ${method}`);
		if (expectation.check) expectation.check(args);
		if (Object.hasOwn(expectation, "error")) throw expectation.error;
		if (expectation.run) return expectation.run(args);
		return expectation.result as StoreMethodResult<K>;
	}

	const store: AccountStoreDouble = {
		calls,
		getPoolVersion: () => invoke("getPoolVersion", []),
		listSelectableAccounts: (nowMs, limit) =>
			invoke("listSelectableAccounts", [nowMs, limit]),
		getAccountForRefresh: (accountId) =>
			invoke("getAccountForRefresh", [accountId]),
		tryAcquireRefreshLock: (accountId, owner, expiresAtMs, nowMs) =>
			invoke("tryAcquireRefreshLock", [accountId, owner, expiresAtMs, nowMs]),
		releaseRefreshLock: (accountId, owner) =>
			invoke("releaseRefreshLock", [accountId, owner]),
		writeRefreshedCookie: (accountId, update) =>
			invoke("writeRefreshedCookie", [accountId, update]),
		writeAccountOutcome: (accountId, outcome) =>
			invoke("writeAccountOutcome", [accountId, outcome]),
		writeAccountProbe: (accountId, probe, checkedAtMs) =>
			invoke("writeAccountProbe", [accountId, probe, checkedAtMs]),
		listAccountCapabilities: (accountIds) =>
			invoke("listAccountCapabilities", [accountIds]),
		listAllAccountCapabilities: (limit) =>
			invoke("listAllAccountCapabilities", [limit]),
		listModelRoutePriorities: () => invoke("listModelRoutePriorities", []),
		replaceModelRoutePriority: (family, routes, nowMs) =>
			invoke("replaceModelRoutePriority", [family, routes, nowMs]),
		clearModelRoutePriority: (family, nowMs) =>
			invoke("clearModelRoutePriority", [family, nowMs]),
		getAdminOverview: (filter, nowMs) =>
			invoke("getAdminOverview", [filter, nowMs]),
		findAccountByCookieHash: (cookieHash, nowMs) =>
			invoke("findAccountByCookieHash", [cookieHash, nowMs]),
		findAccountByIdentityHash: (identityHash, nowMs) =>
			invoke("findAccountByIdentityHash", [identityHash, nowMs]),
		createAccount: (input) => invoke("createAccount", [input]),
		importAccountByIdentity: (entry) =>
			invoke("importAccountByIdentity", [entry]),
		createAccountsBulk: (entries) => invoke("createAccountsBulk", [entries]),
		updateAccount: (accountId, update) =>
			invoke("updateAccount", [accountId, update]),
		deleteAccount: (accountId, nowMs) =>
			invoke("deleteAccount", [accountId, nowMs]),
		setAccountsEnabledBulk: (accountIds, enabled, nowMs) =>
			invoke("setAccountsEnabledBulk", [accountIds, enabled, nowMs]),
		deleteAccountsBulk: (accountIds, nowMs) =>
			invoke("deleteAccountsBulk", [accountIds, nowMs]),
		assertDrained: () => {
			const remaining = ACCOUNT_STORE_METHODS.flatMap((method) => {
				const entries = expectationEntries(expectations[method]);
				const count = entries.length - (offsets.get(method) ?? 0);
				return count > 0 ? [`${method}(${count})`] : [];
			});
			if (remaining.length)
				throw new Error(
					`unconsumed account store calls: ${remaining.join(", ")}`,
				);
		},
	};
	return store;
}

function expectationEntries<K extends StoreMethod>(
	value: StoreMethodExpectation<K> | StoreMethodExpectation<K>[] | undefined,
): StoreMethodExpectation<K>[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

export function normalizeSql(sql: string): string {
	return String(sql).replace(/\s+/g, " ").trim();
}

function assertSql(expected: SqlExpectation, actual: string): void {
	if (expected instanceof RegExp) {
		expected.lastIndex = 0;
		if (expected.test(actual)) return;
	} else if (normalizeSql(expected) === actual) return;
	throw new Error(
		`unexpected D1 SQL: expected ${String(expected)}, received ${actual}`,
	);
}

function assertValues(
	expected: unknown,
	actual: unknown,
	context: string,
): void {
	if (isDeepStrictEqual(expected, actual)) return;
	throw new Error(
		`unexpected values for ${context}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
	);
}
