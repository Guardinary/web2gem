// @ts-nocheck
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { assert } from "../../assertions.js";

const migrationSql = readFileSync(
	"migrations/0001_gemini_accounts.sql",
	"utf8",
);

function tableDefinition(name) {
	const match = new RegExp(
		`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`,
	).exec(migrationSql);
	if (!match) throw new Error(`missing migration table definition: ${name}`);
	return match[0];
}

describe("Gemini account migration", () => {
	test("defines the minimal account columns without legacy compatibility fields", () => {
		const accountTable = tableDefinition("gemini_accounts");
		for (const column of [
			"id",
			"label",
			"enabled",
			"cookie_header",
			"cookie_hash",
			"identity_hash",
			"issue",
			"cooldown_until_ms",
			"last_issue_at_ms",
			"last_used_at_ms",
			"last_refresh_at_ms",
			"account_status_code",
			"status_checked_at_ms",
			"last_refresh_attempt_at_ms",
			"last_refresh_success_at_ms",
			"created_at_ms",
			"updated_at_ms",
		])
			assert.match(migrationSql, new RegExp(`\\b${column}\\b`));
		assert.doesNotMatch(
			migrationSql,
			/row_id|account_category|session_token|success_count|failure_count|source_id/,
		);
		assert.match(accountTable, /cookie_hash TEXT NOT NULL UNIQUE/);
		assert.match(accountTable, /identity_hash TEXT NOT NULL UNIQUE/);
	});

	test("defines capability and route-priority tables at schema version three", () => {
		const capabilityTable = tableDefinition("gemini_account_models");
		const priorityTable = tableDefinition("gemini_model_route_priority");
		assert.match(capabilityTable, /display_name TEXT NOT NULL/);
		for (const contract of [
			/available INTEGER NOT NULL CHECK \(available IN \(0, 1\)\)/,
			/capacity INTEGER NOT NULL CHECK \(capacity BETWEEN 1 AND 4\)/,
			/capacity_field INTEGER NOT NULL CHECK \(capacity_field IN \(12, 13\)\)/,
			/model_number INTEGER NOT NULL CHECK \(model_number BETWEEN 1 AND 64\)/,
			/discovery_order INTEGER NOT NULL CHECK \(discovery_order BETWEEN 0 AND 127\)/,
			/PRIMARY KEY \(account_id, model_id\)/,
		])
			assert.match(capabilityTable, contract);
		for (const contract of [
			/family TEXT NOT NULL CHECK \(family IN \('pro', 'flash', 'flash_lite'\)\)/,
			/capacity INTEGER NOT NULL CHECK \(capacity BETWEEN 1 AND 4\)/,
			/capacity_field INTEGER NOT NULL CHECK \(capacity_field IN \(12, 13\)\)/,
			/model_number INTEGER NOT NULL CHECK \(model_number BETWEEN 1 AND 64\)/,
			/priority INTEGER NOT NULL CHECK \(priority BETWEEN 0 AND 127\)/,
			/UNIQUE \(family, priority\)/,
		])
			assert.match(priorityTable, contract);
		assert.match(migrationSql, /VALUES \('schema_version', '3'/);
	});
});
