// @ts-nocheck
import { describe, test } from "vitest";
import {
	accountBusyLabel,
	accountDisplayName,
	destructiveConfirmationText,
	identifier,
	identifierKey,
	isCooling,
	parseBatchImport,
	relativeTime,
	resultSummary,
} from "../../../src/admin-ui/logic";
import { AdminLocalError } from "../../../src/admin-ui/local-errors";
import { assert } from "../assertions.js";
import { uiAccount } from "./_support/fixtures.js";

describe("admin UI logic", () => {
	test("formats compact mutation summaries with the first safe error", () => {
		assert.equal(
			resultSummary("refresh", {
				processed: 4,
				changed: 2,
				unchanged: 1,
				failed: 1,
				errors: [{ code: "safe", message: "safe failure" }],
			}),
			"refresh completed: processed 4, changed 2, unchanged 1, failed 1 - safe failure",
		);
	});

	test("parses bare dual-cookie import rows", () => {
		assert.deepEqual(
			parseBatchImport("psid-a psidts-a First account\npsid-b,psidts-b"),
			[
				{ psid: "psid-a", psidts: "psidts-a", label: "First account" },
				{ psid: "psid-b", psidts: "psidts-b" },
			],
		);
		let failure: unknown;
		try {
			parseBatchImport("__Secure-1PSID=secret psidts");
		} catch (error) {
			failure = error;
		}
		assert.equal(failure instanceof AdminLocalError, true);
		assert.deepEqual((failure as AdminLocalError).details, {
			key: "Cookie value only",
			params: { name: "__Secure-1PSID" },
		});

		failure = undefined;
		try {
			parseBatchImport("psid-only");
		} catch (error) {
			failure = error;
		}
		assert.equal(failure instanceof AdminLocalError, true);
		assert.deepEqual((failure as AdminLocalError).details, {
			key: "Batch row credentials required",
		});
	});

	test("projects account identity, display, busy, and cooling labels", () => {
		const account = uiAccount({
			label: "Alpha",
			state: "cooling",
			issue: "rate_limit",
			cooldown_until_ms: 61000,
		});
		assert.deepEqual(identifier(account), { id: "account-a" });
		assert.equal(identifierKey(account), "account-a");
		assert.equal(accountDisplayName(account), "Alpha");
		assert.equal(accountBusyLabel(""), "");
		assert.equal(accountBusyLabel("refresh"), "Refresh in progress");
		assert.equal(isCooling(account), true);
	});

	test("formats destructive confirmation copy for singular and plural scopes", () => {
		assert.equal(
			destructiveConfirmationText(1, "loaded account(s)").description,
			"This permanently deletes 1 loaded account. This action cannot be undone.",
		);
		assert.equal(
			destructiveConfirmationText(2, "").confirmLabel,
			"Delete 2 accounts",
		);
	});

	test("formats future relative times at minute, hour, and day boundaries", () => {
		assert.equal(relativeTime(61000, 1000), "in 1m");
		assert.equal(relativeTime(3_601_000, 1000), "in 1h");
		assert.equal(relativeTime(86_401_000, 1000), "in 1d");
	});
});
