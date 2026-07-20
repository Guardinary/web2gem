import { afterEach, describe, test } from "vitest";
import { runAction } from "../../../src/admin-ui/actions";
import {
	resolveConfirmation,
	updateAdminKey,
} from "../../../src/admin-ui/session";
import {
	confirmationDraft,
	connectionVerified,
	rowBusy,
	toastItems,
} from "../../../src/admin-ui/state";
import { assert } from "../assertions.js";
import { withAdminEnvironment } from "./_support/environment.js";
import {
	type RecordedRequest,
	recordedRequest,
	requestBody,
	requiredValue,
	uiAccountOverview,
	uiMutation,
} from "./_support/fixtures.js";
import {
	resetAccountViewState,
	resetAdminSessionState,
} from "./_support/state.js";

describe("admin UI account mutation actions", () => {
	afterEach(() => {
		resolveConfirmation(false);
		resetAccountViewState();
		resetAdminSessionState();
	});

	test("reports an empty selection without issuing a request", async () => {
		let requests = 0;
		await withAdminEnvironment(
			async () => {
				requests++;
				return Response.json(uiMutation());
			},
			async () => {
				await runAction("refresh", []);
			},
		);

		assert.equal(requests, 0);
		assert.match(
			toastItems.value[0]?.message || "",
			/Select at least one account/,
		);
	});

	test("waits for delete confirmation, mutates exact IDs, and clears row busy state", async () => {
		const requests: RecordedRequest[] = [];
		await withAdminEnvironment(
			async (path: RequestInfo | URL, init: RequestInit = {}) => {
				requests.push(recordedRequest(path, init));
				return init.method === "POST"
					? Response.json(uiMutation())
					: Response.json(uiAccountOverview());
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				const deleting = runAction("delete", [{ id: "account/a" }], {
					scope: "row",
					targetLabel: "account Alpha",
				});

				assert.equal(requests.length, 0);
				assert.deepEqual(confirmationDraft.value, {
					action: "delete",
					count: 1,
					targetLabel: "account Alpha",
				});
				resolveConfirmation(true);
				await deleting;
			},
		);

		assert.deepEqual(
			requests.map(({ path, init }) => [path, init.method || "GET"]),
			[
				["/admin/accounts/actions", "POST"],
				["/admin/accounts?limit=200", "GET"],
			],
		);
		assert.deepEqual(JSON.parse(requestBody(requiredValue(requests[0]).init)), {
			action: "delete",
			ids: ["account/a"],
		});
		assert.deepEqual(rowBusy.value, {});
		assert.equal(confirmationDraft.value, null);
	});
});
