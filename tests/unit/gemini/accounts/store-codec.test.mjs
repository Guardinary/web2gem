import { describe, test } from "vitest";
import {
	identityHashFromCookie,
	sha256Hex,
} from "../../../../src/gemini/accounts/normalize";
import { D1GeminiAccountStore } from "../../../../src/gemini/accounts/store-d1";
import { assert } from "../../assertions.js";
import {
	adminSqlRow,
	mutationResult,
	poolVersionExpectation,
	RecordingD1,
} from "./_support/store-fixtures.js";

describe("D1 Gemini account store codec", () => {
	test("binds the positional account codec and maps the canonical identity reread", async () => {
		const cookieHeader = "__Secure-1PSID=p1; __Secure-1PSIDTS=t1";
		const cookieHash = await sha256Hex(cookieHeader);
		const identityHash = await identityHashFromCookie(cookieHeader);
		const stored = adminSqlRow("first", { label: "First" });
		const db = new RecordingD1([
			{
				sql: /INSERT INTO gemini_accounts \(id, label, enabled, cookie_header, cookie_hash, identity_hash, issue, cooldown_until_ms, last_issue_at_ms, last_used_at_ms, last_refresh_at_ms, account_status_code, status_checked_at_ms, last_refresh_attempt_at_ms, last_refresh_success_at_ms, created_at_ms, updated_at_ms\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\) ON CONFLICT\(identity_hash\) DO UPDATE SET/,
				binds: [
					"first",
					"First",
					1,
					cookieHeader,
					cookieHash,
					identityHash,
					null,
					null,
					null,
					null,
					null,
					null,
					null,
					null,
					null,
					1000,
					1000,
				],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(1000),
			{
				sql: /SELECT id, label, enabled, issue, .* FROM gemini_accounts WHERE identity_hash = \? LIMIT 1/,
				binds: [identityHash],
				operation: "first",
				result: stored,
			},
		]);

		const item = await new D1GeminiAccountStore(db).createAccount({
			id: "first",
			label: "First",
			cookieHeader,
			nowMs: 1000,
		});
		assert.equal(item.id, "first");
		assert.equal(item.label, "First");
		assert.equal(item.state, "available");
		db.assertBatches([[0, 1]]);
		db.assertDrained();
	});

	test("maps bulk create rows from separately supplied preflight and reread results", async () => {
		const inputs = await Promise.all(
			[
				["second", "p2"],
				["third", "p3"],
			].map(async ([id, cookie]) => {
				const cookieHeader = `__Secure-1PSID=${cookie}; __Secure-1PSIDTS=t`;
				const cookieHash = await sha256Hex(cookieHeader);
				const identityHash = await identityHashFromCookie(cookieHeader);
				return {
					cookieHash,
					identityHash,
					input: { id, cookieHeader, identityHash, nowMs: 6000 },
				};
			}),
		);
		const insertExpectations = inputs.map((entry) => ({
			sql: /INSERT INTO gemini_accounts .*ON CONFLICT\(identity_hash\) DO UPDATE SET/,
			binds: [
				entry.input.id,
				null,
				1,
				entry.input.cookieHeader,
				entry.cookieHash,
				entry.identityHash,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				6000,
				6000,
			],
			operation: "batch",
			result: mutationResult(),
		}));
		const resultRows = inputs.map((entry) => ({
			cookie_hash: entry.cookieHash,
			...adminSqlRow(entry.input.id),
		}));
		const db = new RecordingD1([
			{
				sql: /SELECT identity_hash, cookie_hash FROM gemini_accounts WHERE identity_hash IN \(\?, \?\)/,
				binds: inputs.map((entry) => entry.identityHash),
				operation: "all",
				result: { results: [] },
			},
			...insertExpectations,
			poolVersionExpectation(6000, "insertedRows", ["second", "third"]),
			{
				sql: /SELECT cookie_hash, id, label, enabled, issue, .* FROM gemini_accounts WHERE cookie_hash IN \(\?, \?\)/,
				binds: inputs.map((entry) => entry.cookieHash),
				operation: "all",
				result: { results: resultRows },
			},
		]);

		const result = await new D1GeminiAccountStore(db).createAccountsBulk(
			inputs,
		);
		assert.deepEqual(
			[...result.itemsByCookieHash.values()].map((item) => item.id),
			["second", "third"],
		);
		assert.deepEqual(
			[...result.addedCookieHashes],
			inputs.map((entry) => entry.cookieHash),
		);
		db.assertBatches([[1, 2, 3]]);
		db.assertDrained();
	});
});
