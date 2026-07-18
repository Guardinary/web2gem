import { describe, test } from "vitest";
import {
	listFilterFromSearchParams,
	normalizeBulkAction,
	normalizeCreateAccounts,
	normalizeListFilter,
	updateFromBody,
} from "../../../../src/gemini/accounts/admin-input";
import { assert } from "../../assertions.js";

describe("Gemini account admin input", () => {
	test("parses list filters and clamps the requested page limit", () => {
		assert.deepEqual(
			listFilterFromSearchParams(
				new URLSearchParams("limit=200&q=alpha&state=attention"),
			),
			{ limit: 200, q: "alpha", state: "attention" },
		);
		assert.deepEqual(normalizeListFilter({ limit: 999, state: "cooling" }), {
			limit: 200,
			state: "cooling",
		});
	});

	test("normalizes the slim account update shape", () => {
		assert.deepEqual(updateFromBody({ label: null, enabled: false }, 1000), {
			label: null,
			enabled: false,
			nowMs: 1000,
		});
	});

	test("rejects legacy query, update, create, and bulk-action fields", () => {
		assert.throws(
			() => listFilterFromSearchParams(new URLSearchParams("status=active")),
			/unknown admin query parameter/,
		);
		assert.throws(
			() => updateFromBody({ status: "active" }, 1000),
			/unsupported account update field/,
		);
		assert.throws(
			() =>
				normalizeCreateAccounts({
					provider: "gemini",
					"__Secure-1PSID": "p",
					"__Secure-1PSIDTS": "t",
					source: "legacy",
				}),
			/only __Secure-1PSID, __Secure-1PSIDTS, and label/,
		);
		assert.throws(
			() => normalizeBulkAction({ action: "check", ids: ["a"] }),
			/action must be enable, disable, delete, or refresh/,
		);
	});

	test("rejects duplicate, empty, and invalid list query values", () => {
		assert.throws(
			() => listFilterFromSearchParams(new URLSearchParams("q=a&q=b")),
			/duplicate admin query parameter/,
		);
		assert.throws(
			() => listFilterFromSearchParams(new URLSearchParams("limit=0")),
			/limit must be an integer/,
		);
		assert.throws(
			() => listFilterFromSearchParams(new URLSearchParams("state=active")),
			/state must be available/,
		);
		assert.throws(
			() => listFilterFromSearchParams(new URLSearchParams("q=")),
			/must not be empty/,
		);
	});

	test("rejects invalid account update value types", () => {
		assert.throws(
			() => updateFromBody({ enabled: 1 }, 1),
			/enabled must be a boolean/,
		);
		assert.throws(
			() => updateFromBody({ label: 1 }, 1),
			/label must be a string or null/,
		);
	});

	test("rejects duplicate, empty, and non-string bulk account IDs", () => {
		assert.throws(
			() => normalizeBulkAction({ action: "enable", ids: ["a", "a"] }),
			/bulk action ids must be unique/,
		);
		assert.throws(
			() => normalizeBulkAction({ action: "enable", ids: [] }),
			/non-empty array/,
		);
		assert.throws(
			() => normalizeBulkAction({ action: "enable", ids: [1] }),
			/each account id must be a string/,
		);
	});

	test("rejects invalid create envelopes and cookie-name-prefixed values", () => {
		assert.throws(
			() => normalizeCreateAccounts({ provider: "other" }),
			/only provider=gemini/,
		);
		assert.throws(
			() => normalizeCreateAccounts({ provider: "gemini", accounts: [] }),
			/account payload is required/,
		);
		assert.throws(
			() =>
				normalizeCreateAccounts({
					"__Secure-1PSID": "__Secure-1PSID=p",
					"__Secure-1PSIDTS": "t",
				}),
			/value, not cookie names/,
		);
	});
});
