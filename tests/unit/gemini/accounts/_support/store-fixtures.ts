// @ts-nocheck
import { isDeepStrictEqual } from "node:util";

export function accountSqlRow(id, overrides = {}) {
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

export function accountSummary(id, overrides = {}) {
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

export function adminSqlRow(id, overrides = {}) {
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

export const durableIssues = ["auth", "user_action", "location"];

const poolVersionSql = {
	changes:
		/INSERT INTO gemini_pool_meta .*SELECT \?, '1', \? WHERE changes\(\) > 0 ON CONFLICT\(key\) DO UPDATE SET/,
	insertedRows:
		/INSERT INTO gemini_pool_meta .*SELECT \?, '1', \? WHERE EXISTS \( SELECT 1 FROM gemini_accounts WHERE id IN \(.*\) \) ON CONFLICT\(key\) DO UPDATE SET/,
	unconditional:
		/INSERT INTO gemini_pool_meta .*SELECT \?, '1', \? ON CONFLICT\(key\) DO UPDATE SET/,
};

export function poolVersionExpectation(
	nowMs,
	mode = "changes",
	extraBinds = [],
) {
	return {
		sql: poolVersionSql[mode],
		binds: ["pool_version", nowMs, ...extraBinds],
		operation: "batch",
		result: { meta: { changes: 1 } },
	};
}

export function mutationResult(changes = 1) {
	return { meta: { changes } };
}

export class RecordingD1 {
	constructor(expectations = []) {
		this.pending = [...expectations];
		this.records = [];
		this.batches = [];
	}

	prepare(sql) {
		const expectation = this.pending.shift();
		if (!expectation)
			throw new Error(`unexpected D1 prepare: ${normalizeSql(sql)}`);
		const normalized = normalizeSql(sql);
		assertSql(expectation.sql, normalized);
		const record = { sql: normalized, binds: null, operation: null };
		this.records.push(record);
		return new RecordingStatement(this, expectation, record);
	}

	async batch(statements) {
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
			return statement.execute("batch");
		});
	}

	assertBatches(expectedRecordIndexes) {
		const actualRecordIndexes = this.batches.map((batch) =>
			batch.map((record) => this.records.indexOf(record)),
		);
		assertValues(expectedRecordIndexes, actualRecordIndexes, "D1 batch groups");
	}

	assertDrained() {
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

	get lastStatement() {
		return this.records.at(-1);
	}
}

class RecordingStatement {
	constructor(db, expectation, record) {
		this.db = db;
		this.expectation = expectation;
		this.record = record;
	}

	bind(...values) {
		if (this.record.binds !== null)
			throw new Error(`D1 statement was bound twice: ${this.record.sql}`);
		assertValues(this.expectation.binds, values, this.record.sql);
		this.record.binds = values;
		return this;
	}

	async first(columnName) {
		if (this.expectation.columnName !== undefined)
			assertValues(
				[this.expectation.columnName],
				[columnName],
				`${this.record.sql} column`,
			);
		return this.execute("first");
	}

	async all() {
		return this.execute("all");
	}

	async run() {
		return this.execute("run");
	}

	execute(operation) {
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
		return this.expectation.result;
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
	"createAccountsBulk",
	"updateAccount",
	"deleteAccount",
	"setAccountsEnabledBulk",
	"deleteAccountsBulk",
];

export function createAccountStoreDouble(expectations = {}) {
	const pending = new Map(
		Object.entries(expectations).map(([method, entries]) => [
			method,
			Array.isArray(entries) ? [...entries] : [entries],
		]),
	);
	const calls = [];
	const store = { calls };

	for (const method of ACCOUNT_STORE_METHODS) {
		store[method] = async (...args) => {
			const queue = pending.get(method);
			const expectation = queue?.shift();
			if (!expectation)
				throw new Error(`unexpected account store call: ${method}`);
			calls.push({ method, args });
			if (Object.hasOwn(expectation, "args"))
				assertValues(expectation.args, args, `account store ${method}`);
			if (expectation.check) expectation.check(args);
			if (Object.hasOwn(expectation, "error")) throw expectation.error;
			if (expectation.run) return expectation.run(args);
			return expectation.result;
		};
	}

	store.assertDrained = () => {
		const remaining = [...pending.entries()].flatMap(([method, entries]) =>
			entries.length ? [`${method}(${entries.length})`] : [],
		);
		if (remaining.length)
			throw new Error(
				`unconsumed account store calls: ${remaining.join(", ")}`,
			);
	};
	return store;
}

export function normalizeSql(sql) {
	return String(sql).replace(/\s+/g, " ").trim();
}

function assertSql(expected, actual) {
	if (expected instanceof RegExp) {
		expected.lastIndex = 0;
		if (expected.test(actual)) return;
	} else if (normalizeSql(expected) === actual) return;
	throw new Error(
		`unexpected D1 SQL: expected ${String(expected)}, received ${actual}`,
	);
}

function assertValues(expected, actual, context) {
	if (isDeepStrictEqual(expected, actual)) return;
	throw new Error(
		`unexpected values for ${context}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
	);
}
