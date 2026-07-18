import { afterEach, describe, test } from "vitest";
import { openEdit, submitEdit } from "../../../src/admin-ui/actions";
import { updateAdminKey } from "../../../src/admin-ui/session";
import {
	accounts,
	connectionVerified,
	editBusy,
	editDraft,
} from "../../../src/admin-ui/state";
import { assert } from "../assertions.js";
import { withAdminEnvironment } from "./_support/environment.js";
import {
	uiAccount,
	uiAccountOverview,
	uiMutation,
} from "./_support/fixtures.js";
import {
	resetAccountViewState,
	resetAdminSessionState,
	resetEditState,
} from "./_support/state.js";

describe("admin UI edit actions", () => {
	afterEach(() => {
		resetEditState();
		resetAccountViewState();
		resetAdminSessionState();
	});

	test("opens an edit draft from the stable account identifier and label", () => {
		openEdit(uiAccount({ id: "account/a", label: "Alpha" }));
		assert.deepEqual(editDraft.value, { key: "account/a", label: "Alpha" });

		openEdit(uiAccount({ id: "account-b", label: null }));
		assert.deepEqual(editDraft.value, { key: "account-b", label: "" });
	});

	test("drops an edit draft whose account is no longer loaded", async () => {
		let requests = 0;
		await withAdminEnvironment(
			async () => {
				requests++;
				return Response.json(uiMutation());
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				editDraft.value = { key: "missing", label: "New" };

				await submitEdit({ preventDefault() {} });
			},
		);

		assert.equal(requests, 0);
		assert.equal(editDraft.value, null);
	});

	test("updates the loaded account, closes the draft, and reloads the page", async () => {
		const account = uiAccount({ id: "account/a", label: "Old" });
		const requests = [];
		await withAdminEnvironment(
			async (path, init = {}) => {
				requests.push({ path: String(path), init });
				return init.method === "PATCH"
					? Response.json(uiMutation())
					: Response.json(
							uiAccountOverview([{ ...account, label: "New label" }]),
						);
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				accounts.value = [account];
				openEdit(account);
				editDraft.value = { ...editDraft.value, label: "  New label  " };

				await submitEdit({ preventDefault() {} });
			},
		);

		assert.deepEqual(
			requests.map(({ path, init }) => [path, init.method || "GET"]),
			[
				["/admin/accounts/account%2Fa", "PATCH"],
				["/admin/accounts?limit=200", "GET"],
			],
		);
		assert.deepEqual(JSON.parse(requests[0].init.body), { label: "New label" });
		assert.equal(editDraft.value, null);
		assert.equal(editBusy.value, false);
		assert.equal(accounts.value[0].label, "New label");
	});
});
