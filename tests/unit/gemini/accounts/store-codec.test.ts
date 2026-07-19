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
	RecordingD1,
	type D1Expectation,
} from "./_support/store-fixtures.js";

function importVersionExpectation(
	nowMs: number,
	pairs: readonly (readonly [string, string])[],
): D1Expectation {
	return {
		sql: /WITH requested\(identity_hash, cookie_hash\) AS \( SELECT json_extract\(value, '\$\[0\]'\), json_extract\(value, '\$\[1\]'\) FROM json_each\(\?\) \) INSERT INTO gemini_pool_meta .* WHERE EXISTS .* RETURNING .* AS preexisting_ids/,
		binds: [JSON.stringify(pairs), "pool_version", nowMs],
		operation: "batch",
		result: {
			meta: { changes: 1 },
			results: [
				{
					preexisting_ids: JSON.stringify(
						Object.fromEntries(
							pairs.map(([identityHash]) => [identityHash, null]),
						),
					),
				},
			],
		},
	};
}

describe("D1 Gemini account store codec", () => {
	test("binds the positional account codec and maps the canonical identity reread", async () => {
		const cookieHeader = "__Secure-1PSID=p1; __Secure-1PSIDTS=t1";
		const cookieHash = await sha256Hex(cookieHeader);
		const identityHash = await identityHashFromCookie(cookieHeader);
		const stored = adminSqlRow("first", { label: "First" });
		const db = new RecordingD1([
			importVersionExpectation(1000, [[identityHash, cookieHash]]),
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
			{
				sql: /SELECT identity_hash, id, label, enabled, issue, .* FROM gemini_accounts WHERE identity_hash IN \(\?\)/,
				binds: [identityHash],
				operation: "all",
				result: { results: [{ identity_hash: identityHash, ...stored }] },
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
		const inputPairs = [
			["second", "p2"],
			["third", "p3"],
		] as const;
		const inputs = await Promise.all(
			inputPairs.map(async ([id, cookie]) => {
				const cookieHeader = `__Secure-1PSID=${cookie}; __Secure-1PSIDTS=t`;
				const cookieHash = await sha256Hex(cookieHeader);
				const identityHash = await identityHashFromCookie(cookieHeader);
				return {
					cookieHash,
					input: { id, cookieHeader, identityHash, nowMs: 6000 },
				};
			}),
		);
		const insertExpectations: D1Expectation[] = inputs.map((entry) => ({
			sql: /INSERT INTO gemini_accounts .*ON CONFLICT\(identity_hash\) DO UPDATE SET/,
			binds: [
				entry.input.id,
				null,
				1,
				entry.input.cookieHeader,
				entry.cookieHash,
				entry.input.identityHash,
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
			identity_hash: entry.input.identityHash,
			...adminSqlRow(entry.input.id),
		}));
		const db = new RecordingD1([
			importVersionExpectation(
				6000,
				inputs.map((entry) => [entry.input.identityHash, entry.cookieHash]),
			),
			...insertExpectations,
			{
				sql: /SELECT identity_hash, id FROM gemini_accounts WHERE identity_hash IN \(\?, \?\)/,
				binds: inputs.map((entry) => entry.input.identityHash),
				operation: "all",
				result: {
					results: resultRows.map((row) => ({
						identity_hash: row.identity_hash,
						id: row.id,
					})),
				},
			},
		]);

		const result = await new D1GeminiAccountStore(db).createAccountsBulk(
			inputs,
		);
		assert.deepEqual([...result.createdAccountIds], ["second", "third"]);
		assert.equal(result.changedCredentialCount, 0);
		db.assertBatches([[0, 1, 2]]);
		db.assertDrained();
	});
});
