import { afterEach, describe, test } from "vitest";
import {
	hasFilters,
	metricSummary,
	selectedCount,
} from "../../../src/admin-ui/selectors";
import {
	accountStats,
	accounts,
	query,
	selected,
	stateFilter,
} from "../../../src/admin-ui/state";
import { assert } from "../assertions.js";
import { emptyStats, uiAccount } from "./_support/fixtures.js";
import { resetSelectorState } from "./_support/state.js";

describe("admin UI selectors", () => {
	afterEach(resetSelectorState);

	test("derives metric counts from the loaded rows when stats are absent", () => {
		accounts.value = [
			uiAccount({ id: "available" }),
			uiAccount({ id: "cooling", state: "cooling" }),
			uiAccount({ id: "attention", state: "attention" }),
			uiAccount({ id: "disabled", state: "disabled" }),
		];

		assert.deepEqual(metricSummary.value, {
			total: 4,
			available: 1,
			cooling: 1,
			attention: 1,
			disabled: 1,
		});
	});

	test("uses server metric totals when an overview supplies stats", () => {
		accounts.value = [uiAccount()];
		accountStats.value = emptyStats({
			total: 12,
			available: 7,
			cooling: 2,
			attention: 2,
			disabled: 1,
		});

		assert.deepEqual(metricSummary.value, accountStats.value);
	});

	test("projects selection count and normalized filter presence", () => {
		selected.value = new Set(["a", "b"]);
		query.value = "   ";
		assert.equal(selectedCount.value, 2);
		assert.equal(hasFilters.value, false);

		query.value = " account ";
		assert.equal(hasFilters.value, true);
		query.value = "";
		stateFilter.value = "attention";
		assert.equal(hasFilters.value, true);
	});
});
