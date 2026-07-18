import { afterEach, describe, test } from "vitest";
import { selectedIdentifiers } from "../../../src/admin-ui/actions";
import { accounts, selected } from "../../../src/admin-ui/state";
import { assert } from "../assertions.js";
import { uiAccount } from "./_support/fixtures.js";
import { resetAccountViewState } from "./_support/state.js";

describe("admin UI account selection actions", () => {
	afterEach(resetAccountViewState);

	test("returns visible selected identifiers in account order and drops stale keys", () => {
		accounts.value = [
			uiAccount({ id: "second" }),
			uiAccount({ id: "first" }),
			uiAccount({ id: "unselected" }),
		];
		selected.value = new Set(["first", "stale", "second"]);

		assert.deepEqual(selectedIdentifiers(), [
			{ id: "second" },
			{ id: "first" },
		]);
	});
});
