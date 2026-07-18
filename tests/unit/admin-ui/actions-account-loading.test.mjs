import { afterEach, describe, test } from "vitest";
import { loadAccounts } from "../../../src/admin-ui/actions";
import { updateAdminKey } from "../../../src/admin-ui/session";
import {
	accountStats,
	accounts,
	adminKey,
	authExpanded,
	connectionVerified,
	cursorStack,
	modelRouting,
	nextCursor,
	pageIndex,
	query,
	selected,
	stateFilter,
	toastItems,
} from "../../../src/admin-ui/state";
import { assert } from "../assertions.js";
import { deferred } from "../_support/deferred.js";
import { withAdminEnvironment } from "./_support/environment.js";
import {
	emptyStats,
	uiAccount,
	uiAccountOverview,
	uiModelRouting,
} from "./_support/fixtures.js";
import {
	resetAccountViewState,
	resetAdminSessionState,
	resetModelRoutingState,
} from "./_support/state.js";

describe("admin UI account loading actions", () => {
	afterEach(() => {
		resetAccountViewState();
		resetModelRoutingState();
		resetAdminSessionState();
	});

	test("verifies from a valid account overview before loading model routing", async () => {
		const account = uiAccount({ label: "Primary" });
		const overview = uiAccountOverview([account], { nextCursor: "cursor-2" });
		const routing = uiModelRouting();
		const requests = [];
		const routingStarted = deferred();
		const routingResponse = deferred();
		let verifiedWhenRoutingRequested = false;
		try {
			await withAdminEnvironment(
				async (path) => {
					requests.push(String(path));
					if (String(path) !== "/admin/model-routing")
						return Response.json(overview);
					verifiedWhenRoutingRequested = connectionVerified.value;
					routingStarted.resolve();
					return routingResponse.promise;
				},
				async () => {
					updateAdminKey("admin-secret");
					authExpanded.value = true;

					const verification = loadAccounts("reset", true);
					try {
						const requestedRouting = await Promise.race([
							routingStarted.promise.then(() => true),
							verification.then(() => false),
						]);
						assert.equal(requestedRouting, true);
						assert.equal(verifiedWhenRoutingRequested, true);
						assert.equal(connectionVerified.value, true);
						assert.equal(authExpanded.value, false);
						assert.deepEqual(accounts.value, [account]);
						assert.deepEqual(accountStats.value, overview.stats);
						assert.equal(modelRouting.value, null);
					} finally {
						routingResponse.resolve(Response.json(routing));
						await verification;
					}
				},
			);

			assert.deepEqual(requests, [
				"/admin/accounts?limit=200",
				"/admin/model-routing",
			]);
			assert.equal(connectionVerified.value, true);
			assert.equal(authExpanded.value, false);
			assert.deepEqual(accounts.value, [account]);
			assert.deepEqual(accountStats.value, overview.stats);
			assert.equal(nextCursor.value, "cursor-2");
			assert.deepEqual(modelRouting.value, routing);
		} finally {
			routingStarted.resolve();
			routingResponse.resolve(Response.json(routing));
		}
	});

	test("navigates cursor pages and retains only selections visible on the page", async () => {
		const first = uiAccount({ id: "first" });
		const retained = uiAccount({ id: "retained", state: "attention" });
		const third = uiAccount({ id: "third", state: "attention" });
		const requests = [];
		await withAdminEnvironment(
			async (path) => {
				requests.push(String(path));
				if (requests.length === 1)
					return Response.json(uiAccountOverview([retained, third]));
				if (requests.length === 2)
					return Response.json(
						uiAccountOverview([first, retained], { nextCursor: "cursor-2" }),
					);
				return Response.json(uiAccountOverview([retained]));
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				accounts.value = [first, retained];
				selected.value = new Set(["first", "retained", "stale"]);
				nextCursor.value = "cursor-2";
				query.value = "  alpha  ";
				stateFilter.value = "attention";

				await loadAccounts("next");
				assert.deepEqual([...selected.value], ["retained"]);
				assert.equal(pageIndex.value, 1);
				assert.deepEqual(cursorStack.value, ["", "cursor-2"]);

				await loadAccounts("prev");
				assert.equal(pageIndex.value, 0);
				assert.deepEqual([...selected.value], ["retained"]);

				await loadAccounts("reset");
				assert.deepEqual([...selected.value], []);
			},
		);

		assert.deepEqual(requests, [
			"/admin/accounts?limit=200&cursor=cursor-2&q=alpha&state=attention",
			"/admin/accounts?limit=200&q=alpha&state=attention",
			"/admin/accounts?limit=200&q=alpha&state=attention",
		]);
	});

	test("invalidates verification when the account overview is malformed", async () => {
		let requests = 0;
		await withAdminEnvironment(
			async () => {
				requests++;
				return Response.json({ items: [], nextCursor: null, limit: 200 });
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				modelRouting.value = uiModelRouting();

				await loadAccounts("reset", true);
			},
		);

		assert.equal(requests, 1);
		assert.equal(connectionVerified.value, false);
		assert.equal(authExpanded.value, true);
		assert.equal(modelRouting.value, null);
	});

	test("requires an admin key before issuing a verification request", async () => {
		let requests = 0;
		await withAdminEnvironment(
			async () => {
				requests++;
				return Response.json(uiAccountOverview());
			},
			async () => {
				adminKey.value = "";
				await loadAccounts("reset", true);
			},
		);

		assert.equal(requests, 0);
		assert.equal(connectionVerified.value, false);
		assert.match(toastItems.value[0]?.message || "", /Admin key is required/);
	});

	test("discards an in-flight verification response after the credential changes", async () => {
		const requestStarted = deferred();
		const pendingOverview = deferred();
		try {
			await withAdminEnvironment(
				async () => {
					requestStarted.resolve();
					return pendingOverview.promise;
				},
				async () => {
					updateAdminKey("old-admin-key");
					const verification = loadAccounts("reset", true);
					await requestStarted.promise;

					updateAdminKey("new-admin-key");
					pendingOverview.resolve(
						Response.json(
							uiAccountOverview([uiAccount()], {
								stats: emptyStats({ total: 1, available: 1 }),
							}),
						),
					);
					await verification;
				},
			);

			assert.equal(adminKey.value, "new-admin-key");
			assert.equal(connectionVerified.value, false);
			assert.deepEqual(accounts.value, []);
			assert.equal(accountStats.value, null);
			assert.equal(modelRouting.value, null);
		} finally {
			requestStarted.resolve();
			pendingOverview.resolve(Response.json(uiAccountOverview()));
		}
	});

	test("commits only the newest account overview within one admin session", async () => {
		const firstStarted = deferred();
		const secondStarted = deferred();
		const firstResponse = deferred();
		const secondResponse = deferred();
		let requestCount = 0;
		try {
			await withAdminEnvironment(
				async () => {
					requestCount++;
					if (requestCount === 1) {
						firstStarted.resolve();
						return firstResponse.promise;
					}
					secondStarted.resolve();
					return secondResponse.promise;
				},
				async () => {
					updateAdminKey("admin-secret");
					connectionVerified.value = true;

					const first = loadAccounts();
					await firstStarted.promise;
					const second = loadAccounts();
					await secondStarted.promise;
					secondResponse.resolve(
						Response.json(
							uiAccountOverview([], {
								stats: emptyStats({ total: 2, available: 2 }),
							}),
						),
					);
					await second;
					firstResponse.resolve(
						Response.json(
							uiAccountOverview([], {
								stats: emptyStats({ total: 1, available: 1 }),
							}),
						),
					);
					await first;
				},
			);

			assert.equal(accountStats.value.total, 2);
			assert.equal(connectionVerified.value, true);
		} finally {
			firstStarted.resolve();
			secondStarted.resolve();
			firstResponse.resolve(Response.json(uiAccountOverview()));
			secondResponse.resolve(Response.json(uiAccountOverview()));
		}
	});

	test("invalidates the verified admin session when credentials are rejected", async () => {
		await withAdminEnvironment(
			async () =>
				Response.json(
					{
						error: {
							code: "invalid_admin_key",
							message: "invalid admin key",
						},
					},
					{ status: 401 },
				),
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				authExpanded.value = false;
				accounts.value = [uiAccount()];
				accountStats.value = emptyStats({ total: 1, available: 1 });
				modelRouting.value = uiModelRouting();

				await loadAccounts();
			},
		);

		assert.equal(connectionVerified.value, false);
		assert.equal(authExpanded.value, true);
		assert.deepEqual(accounts.value, []);
		assert.equal(accountStats.value, null);
		assert.equal(modelRouting.value, null);
	});
});
