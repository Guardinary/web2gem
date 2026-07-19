// @ts-nocheck
import { describe, test } from "vitest";
import { emptyModelRoutingDrafts } from "../../../src/admin-ui/state";
import { assert } from "../assertions.js";
import { uiModelRouting } from "./_support/fixtures.js";

describe("admin UI state factories", () => {
	test("creates independent model-routing drafts for every family and call", () => {
		const first = emptyModelRoutingDrafts();
		const second = emptyModelRoutingDrafts();
		first.pro.routes.push(uiModelRouting().families[0].routes[0]);
		first.flash.busy = true;

		assert.equal(first.pro === first.flash, false);
		assert.equal(first.pro.routes === first.flash.routes, false);
		assert.deepEqual(first.flash.routes, []);
		assert.deepEqual(second, {
			pro: { routes: [], busy: false, error: null, dirty: false },
			flash: { routes: [], busy: false, error: null, dirty: false },
			flash_lite: { routes: [], busy: false, error: null, dirty: false },
		});
	});
});
