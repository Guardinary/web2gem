import { assert } from "./assertions.js";
import { mod } from "./helpers.js";

export const suiteName = "gemini account admin UI";
export const cases = [
	[
		"resolves language and theme preferences without browser state",
		() => {
			assert.equal(mod.detectLanguage("zh-CN"), "zh-CN");
			assert.equal(mod.detectLanguage("en-US"), "en");
			assert.equal(mod.resolveTheme("system", true), "dark");
			assert.equal(mod.resolveTheme("system", false), "light");
			assert.equal(mod.resolveTheme("light", true), "light");
		},
	],
	[
		"uses strict slim account, overview, and mutation schemas",
		() => {
			const account = uiAccount();
			assert.equal(mod.isAccount(account), true);
			assert.equal(mod.isAccount({ ...account, cookie_hash: "secret" }), false);
			assert.equal(
				mod.isAccount({
					id: "legacy",
					row_id: "legacy-row",
					status: "active",
					enabled: 1,
				}),
				false,
			);
			assert.deepEqual(
				mod.parseOverview({
					items: [account],
					nextCursor: null,
					limit: 200,
					stats: emptyStats({ total: 1, available: 1 }),
				}),
				{
					items: [account],
					nextCursor: null,
					limit: 200,
					stats: emptyStats({ total: 1, available: 1 }),
				},
			);
			assert.throws(
				() => mod.parseMutation({ added: 1, skipped: 0 }),
				/admin mutation response is invalid/,
			);
			assert.deepEqual(
				mod.parseMutation({
					processed: 2,
					changed: 1,
					unchanged: 1,
					failed: 0,
				}),
				{ processed: 2, changed: 1, unchanged: 1, failed: 0 },
			);
		},
	],
	[
		"builds resource paths and merges compact mutation results",
		() => {
			assert.equal(
				mod.accountResourcePath("account/a"),
				"/admin/accounts/account%2Fa",
			);
			assert.deepEqual(
				mod.mergeMutationResults([
					{ processed: 2, changed: 1, unchanged: 1, failed: 0 },
					{
						processed: 2,
						changed: 1,
						unchanged: 0,
						failed: 1,
						errors: [{ id: "b", code: "safe", message: "safe failure" }],
					},
				]),
				{
					processed: 4,
					changed: 2,
					unchanged: 1,
					failed: 1,
					errors: [{ id: "b", code: "safe", message: "safe failure" }],
				},
			);
			assert.equal(
				mod.resultSummary("refresh", {
					processed: 4,
					changed: 2,
					unchanged: 1,
					failed: 1,
					errors: [{ code: "safe", message: "safe failure" }],
				}),
				"refresh completed: processed 4, changed 2, unchanged 1, failed 1 - safe failure",
			);
		},
	],
	[
		"validates and requests exact model routing DTOs",
		async () => {
			const overview = uiModelRouting();
			assert.deepEqual(mod.parseModelRoutingOverview(overview), overview);
			assert.throws(
				() =>
					mod.parseModelRoutingOverview({
						...overview,
						families: [
							{
								...overview.families[0],
								routes: [
									{
										...overview.families[0].routes[0],
										cookie_hash: "secret",
									},
								],
							},
						],
					}),
				/admin model routing response is invalid/,
			);
			assert.throws(
				() =>
					mod.parseModelRoutingOverview({
						...overview,
						version: "not-a-pool-version",
					}),
				/admin model routing response is invalid/,
			);

			const originalFetch = globalThis.fetch;
			const requests = [];
			const session = uiAdminApiSession();
			try {
				globalThis.fetch = async (path, init = {}) => {
					requests.push({ path, init });
					return Response.json(overview);
				};
				await mod.getModelRoutingOverview(session);
				await mod.replaceModelRoutePriority(session, "pro", [
					{
						providerModelId: "9d8ca3786ebdfbea",
						capacity: 3,
						capacityField: 13,
						modelNumber: 3,
					},
				]);
				await mod.resetModelRoutePriority(session, "pro");
				assert.deepEqual(
					requests.map((item) => [item.path, item.init.method || "GET"]),
					[
						["/admin/model-routing", "GET"],
						["/admin/model-routing/pro", "PUT"],
						["/admin/model-routing/pro", "DELETE"],
					],
				);
				assert.deepEqual(JSON.parse(requests[1].init.body), {
					routes: [
						{
							providerModelId: "9d8ca3786ebdfbea",
							capacity: 3,
							capacityField: 13,
							modelNumber: 3,
						},
					],
				});
				assert.equal(
					requests.every((item) => item.init.signal === session.signal),
					true,
				);
			} finally {
				globalThis.fetch = originalFetch;
			}
		},
	],
	[
		"keeps model routing draft order separate from the saved overview",
		async () => {
			const overview = uiModelRouting();
			mod.updateAdminKey("admin-secret");
			mod.connectionVerified.value = true;
			mod.modelRouting.value = overview;
			mod.modelRoutingDrafts.value = {
				pro: {
					routes: [
						overview.families[0].routes[0],
						{
							...overview.families[0].routes[0],
							providerModelId: "e6fa609c3fa255c0",
							capacity: 4,
							capacityField: 12,
						},
					],
					busy: false,
					error: null,
					dirty: false,
				},
				flash: {
					routes: [
						{
							...overview.families[0].routes[0],
							providerModelId: "56fdd199312815e2",
							capacity: 4,
							capacityField: 12,
							modelNumber: 1,
						},
					],
					busy: false,
					error: null,
					dirty: true,
				},
				flash_lite: { routes: [], busy: false, error: null, dirty: false },
			};
			mod.moveModelRoute("pro", 1, -1);
			assert.deepEqual(
				mod.modelRoutingDrafts.value.pro.routes.map(
					(route) => route.providerModelId,
				),
				["e6fa609c3fa255c0", "9d8ca3786ebdfbea"],
			);
			assert.equal(mod.modelRoutingDrafts.value.pro.dirty, true);
			assert.equal(
				mod.modelRouting.value.families[0].routes[0].providerModelId,
				"9d8ca3786ebdfbea",
			);

			const originalFetch = globalThis.fetch;
			const originalWindow = globalThis.window;
			try {
				globalThis.window = { setTimeout: () => 0 };
				globalThis.fetch = async () => Response.json(overview);
				await mod.saveModelRoutePriority("pro");
				assert.equal(
					mod.modelRoutingDrafts.value.flash.routes[0].providerModelId,
					"56fdd199312815e2",
				);
				assert.equal(mod.modelRoutingDrafts.value.flash.dirty, true);
				assert.equal(mod.modelRoutingDrafts.value.pro.dirty, false);
			} finally {
				globalThis.fetch = originalFetch;
				if (originalWindow === undefined) delete globalThis.window;
				else globalThis.window = originalWindow;
				mod.updateAdminKey("");
			}
		},
	],
	[
		"keeps the newest model routing snapshot across out-of-order family saves",
		async () => {
			const originalFetch = globalThis.fetch;
			const originalWindow = globalThis.window;
			const base = uiModelRouting();
			const baseRoute = base.families[0].routes[0];
			const proOld = { ...baseRoute, providerModelId: "pro-old" };
			const proNew = { ...baseRoute, providerModelId: "pro-new" };
			const flashOld = {
				...baseRoute,
				providerModelId: "flash-old",
				modelNumber: 1,
			};
			const flashNew = { ...flashOld, providerModelId: "flash-new" };
			const overview = (version, proRoute, flashRoute) => ({
				...base,
				version,
				families: base.families.map((family) => {
					if (family.family === "pro")
						return { ...family, configured: true, routes: [proRoute] };
					if (family.family === "flash")
						return { ...family, configured: true, routes: [flashRoute] };
					return family;
				}),
			});
			const pending = new Map();
			try {
				globalThis.window = { setTimeout: () => 0 };
				globalThis.fetch = async (path) =>
					new Promise((resolve) => pending.set(String(path), resolve));
				mod.updateAdminKey("admin-secret");
				mod.connectionVerified.value = true;
				mod.modelRouting.value = overview("8", proOld, flashOld);
				mod.modelRoutingDrafts.value = {
					pro: {
						routes: [proNew],
						busy: false,
						error: null,
						dirty: true,
					},
					flash: {
						routes: [flashNew],
						busy: false,
						error: null,
						dirty: true,
					},
					flash_lite: {
						routes: [],
						busy: false,
						error: null,
						dirty: false,
					},
				};

				const proSave = mod.saveModelRoutePriority("pro");
				const flashSave = mod.saveModelRoutePriority("flash");
				pending.get("/admin/model-routing/flash")?.(
					Response.json(overview("10", proNew, flashNew)),
				);
				await flashSave;
				pending.get("/admin/model-routing/pro")?.(
					Response.json(overview("9", proNew, flashOld)),
				);
				await proSave;

				assert.equal(mod.modelRouting.value.version, "10");
				assert.equal(
					mod.modelRouting.value.families.find(
						(family) => family.family === "flash",
					).routes[0].providerModelId,
					"flash-new",
				);
				assert.equal(
					mod.modelRoutingDrafts.value.pro.routes[0].providerModelId,
					"pro-new",
				);
				assert.equal(
					mod.modelRoutingDrafts.value.flash.routes[0].providerModelId,
					"flash-new",
				);
				assert.equal(mod.modelRoutingDrafts.value.pro.busy, false);
				assert.equal(mod.modelRoutingDrafts.value.pro.dirty, false);
				assert.equal(mod.modelRoutingDrafts.value.flash.busy, false);
				assert.equal(mod.modelRoutingDrafts.value.flash.dirty, false);
			} finally {
				globalThis.fetch = originalFetch;
				if (originalWindow === undefined) delete globalThis.window;
				else globalThis.window = originalWindow;
				mod.updateAdminKey("");
			}
		},
	],
	[
		"invalidates all protected admin state when the credential changes",
		() => {
			const overview = uiModelRouting();
			mod.adminKey.value = "old-admin-key";
			mod.connectionVerified.value = true;
			mod.authExpanded.value = false;
			mod.accounts.value = [uiAccount()];
			mod.accountStats.value = emptyStats({ total: 1, available: 1 });
			mod.modelRouting.value = overview;
			mod.modelRoutingDrafts.value = {
				pro: {
					routes: overview.families[0].routes,
					busy: true,
					error: null,
					dirty: true,
				},
				flash: { routes: [], busy: false, error: null, dirty: false },
				flash_lite: { routes: [], busy: false, error: null, dirty: false },
			};

			mod.updateAdminKey("new-admin-key");

			assert.equal(mod.adminKey.value, "new-admin-key");
			assert.equal(mod.connectionVerified.value, false);
			assert.equal(mod.authExpanded.value, true);
			assert.deepEqual(mod.accounts.value, []);
			assert.equal(mod.accountStats.value, null);
			assert.equal(mod.modelRouting.value, null);
			assert.deepEqual(mod.modelRoutingDrafts.value, {
				pro: { routes: [], busy: false, error: null, dirty: false },
				flash: { routes: [], busy: false, error: null, dirty: false },
				flash_lite: { routes: [], busy: false, error: null, dirty: false },
			});
		},
	],
	[
		"discards an in-flight verification response after the credential changes",
		async () => {
			const originalFetch = globalThis.fetch;
			const originalWindow = globalThis.window;
			let resolveOverview;
			const pendingOverview = new Promise((resolve) => {
				resolveOverview = resolve;
			});
			try {
				globalThis.window = { setTimeout: () => 0 };
				globalThis.fetch = async () => pendingOverview;
				mod.updateAdminKey("old-admin-key");
				const verification = mod.loadAccounts("reset", true);
				await Promise.resolve();

				mod.updateAdminKey("new-admin-key");
				resolveOverview(
					Response.json({
						items: [uiAccount()],
						nextCursor: null,
						limit: 200,
						stats: emptyStats({ total: 1, available: 1 }),
					}),
				);
				await verification;

				assert.equal(mod.adminKey.value, "new-admin-key");
				assert.equal(mod.connectionVerified.value, false);
				assert.deepEqual(mod.accounts.value, []);
				assert.equal(mod.accountStats.value, null);
				assert.equal(mod.modelRouting.value, null);
			} finally {
				globalThis.fetch = originalFetch;
				if (originalWindow === undefined) delete globalThis.window;
				else globalThis.window = originalWindow;
				mod.updateAdminKey("");
			}
		},
	],
	[
		"commits only the newest account overview within one admin session",
		async () => {
			const originalFetch = globalThis.fetch;
			const originalWindow = globalThis.window;
			const pending = [];
			const overview = (total) =>
				Response.json({
					items: [],
					nextCursor: null,
					limit: 200,
					stats: emptyStats({ total, available: total }),
				});
			try {
				globalThis.window = { setTimeout: () => 0 };
				globalThis.fetch = async () =>
					new Promise((resolve) => pending.push(resolve));
				mod.updateAdminKey("admin-secret");
				mod.connectionVerified.value = true;

				const first = mod.loadAccounts();
				await Promise.resolve();
				const second = mod.loadAccounts();
				await Promise.resolve();
				pending[1]?.(overview(2));
				await second;
				pending[0]?.(overview(1));
				await first;

				assert.equal(mod.accountStats.value.total, 2);
				assert.equal(mod.connectionVerified.value, true);
			} finally {
				globalThis.fetch = originalFetch;
				if (originalWindow === undefined) delete globalThis.window;
				else globalThis.window = originalWindow;
				mod.updateAdminKey("");
			}
		},
	],
	[
		"invalidates the verified admin session when credentials are rejected",
		async () => {
			const originalFetch = globalThis.fetch;
			const originalWindow = globalThis.window;
			try {
				globalThis.window = { setTimeout: () => 0 };
				globalThis.fetch = async () =>
					Response.json(
						{
							error: {
								code: "invalid_admin_key",
								message: "invalid admin key",
							},
						},
						{ status: 401 },
					);
				const overview = uiModelRouting();
				mod.updateAdminKey("admin-secret");
				mod.connectionVerified.value = true;
				mod.authExpanded.value = false;
				mod.accounts.value = [uiAccount()];
				mod.accountStats.value = emptyStats({ total: 1, available: 1 });
				mod.modelRouting.value = overview;
				mod.modelRoutingDrafts.value = {
					pro: {
						routes: overview.families[0].routes,
						busy: false,
						error: null,
						dirty: true,
					},
					flash: { routes: [], busy: false, error: null, dirty: false },
					flash_lite: { routes: [], busy: false, error: null, dirty: false },
				};

				await mod.loadAccounts();

				assert.equal(mod.connectionVerified.value, false);
				assert.equal(mod.authExpanded.value, true);
				assert.deepEqual(mod.accounts.value, []);
				assert.equal(mod.accountStats.value, null);
				assert.equal(mod.modelRouting.value, null);
				assert.deepEqual(mod.modelRoutingDrafts.value, {
					pro: { routes: [], busy: false, error: null, dirty: false },
					flash: { routes: [], busy: false, error: null, dirty: false },
					flash_lite: { routes: [], busy: false, error: null, dirty: false },
				});
			} finally {
				globalThis.fetch = originalFetch;
				if (originalWindow === undefined) delete globalThis.window;
				else globalThis.window = originalWindow;
				mod.updateAdminKey("");
			}
		},
	],
	[
		"invalidates the verified admin session when a mutation is rejected",
		async () => {
			const originalFetch = globalThis.fetch;
			const originalWindow = globalThis.window;
			try {
				globalThis.window = { setTimeout: () => 0 };
				globalThis.fetch = async () =>
					Response.json(
						{
							error: {
								code: "invalid_admin_key",
								message: "invalid admin key",
							},
						},
						{ status: 401 },
					);
				const overview = uiModelRouting();
				mod.updateAdminKey("admin-secret");
				mod.connectionVerified.value = true;
				mod.modelRouting.value = overview;
				mod.modelRoutingDrafts.value = {
					pro: {
						routes: overview.families[0].routes,
						busy: false,
						error: null,
						dirty: true,
					},
					flash: { routes: [], busy: false, error: null, dirty: false },
					flash_lite: { routes: [], busy: false, error: null, dirty: false },
				};

				await mod.saveModelRoutePriority("pro");

				assert.equal(mod.connectionVerified.value, false);
				assert.equal(mod.modelRouting.value, null);
				assert.deepEqual(mod.modelRoutingDrafts.value.pro, {
					routes: [],
					busy: false,
					error: null,
					dirty: false,
				});
			} finally {
				globalThis.fetch = originalFetch;
				if (originalWindow === undefined) delete globalThis.window;
				else globalThis.window = originalWindow;
				mod.updateAdminKey("");
			}
		},
	],
	[
		"blocks account import until the admin session is verified",
		async () => {
			const originalFetch = globalThis.fetch;
			let requests = 0;
			try {
				globalThis.fetch = async () => {
					requests++;
					return Response.json({
						processed: 1,
						changed: 1,
						unchanged: 0,
						failed: 0,
					});
				};
				mod.updateAdminKey("admin-secret");
				mod.connectionVerified.value = false;
				mod.importPsid.value = "psid-value";
				mod.importPsidts.value = "psidts-value";

				await mod.submitImport({ preventDefault() {} });

				assert.equal(requests, 0);
			} finally {
				globalThis.fetch = originalFetch;
				mod.importPsid.value = "";
				mod.importPsidts.value = "";
				mod.importBatch.value = "";
				mod.updateAdminKey("");
			}
		},
	],
	[
		"retries only Worker-limited imports in ordered 40-account chunks",
		async () => {
			const originalFetch = globalThis.fetch;
			const requestSizes = [];
			try {
				globalThis.fetch = async (_path, init) => {
					const payload = JSON.parse(String(init?.body || "{}"));
					requestSizes.push(payload.accounts.length);
					if (requestSizes.length === 1)
						return Response.json(
							{
								error: {
									message: "Worker import limit exceeded",
									code: "gemini_import_account_limit_exceeded",
								},
							},
							{ status: 413 },
						);
					return Response.json({
						processed: payload.accounts.length,
						changed: payload.accounts.length,
						unchanged: 0,
						failed: 0,
					});
				};
				const result = await mod.createAccountsWithLimitFallback(
					uiAdminApiSession(),
					{ accounts: uiImportBatch(81) },
				);
				assert.deepEqual(requestSizes, [81, 40, 40, 1]);
				assert.deepEqual(result, {
					processed: 81,
					changed: 81,
					unchanged: 0,
					failed: 0,
				});
			} finally {
				globalThis.fetch = originalFetch;
			}
		},
	],
	[
		"does not retry unrelated or non-JSON import failures",
		async () => {
			const originalFetch = globalThis.fetch;
			let requests = 0;
			try {
				globalThis.fetch = async () => {
					requests++;
					return new Response("upstream failure", { status: 500 });
				};
				await assert.rejects(
					() =>
						mod.createAccountsWithLimitFallback(uiAdminApiSession(), {
							accounts: uiImportBatch(81),
						}),
					/Request failed with status 500/,
				);
				assert.equal(requests, 1);
			} finally {
				globalThis.fetch = originalFetch;
			}
		},
	],
	[
		"aborts the full import request tree when the admin session changes",
		async () => {
			const originalFetch = globalThis.fetch;
			const originalWindow = globalThis.window;
			const requestSizes = [];
			let activeChunkSignal;
			let notifyChunkStarted;
			const chunkStarted = new Promise((resolve) => {
				notifyChunkStarted = resolve;
			});
			try {
				globalThis.window = { setTimeout: () => 0 };
				globalThis.fetch = async (_path, init = {}) => {
					const payload = JSON.parse(String(init.body || "{}"));
					requestSizes.push(payload.accounts.length);
					if (requestSizes.length === 1)
						return Response.json(
							{
								error: {
									message: "Worker import limit exceeded",
									code: "gemini_import_account_limit_exceeded",
								},
							},
							{ status: 413 },
						);
					activeChunkSignal = init.signal;
					notifyChunkStarted();
					return new Promise((resolve) => {
						init.signal.addEventListener(
							"abort",
							() =>
								resolve(
									Response.json({
										processed: payload.accounts.length,
										changed: payload.accounts.length,
										unchanged: 0,
										failed: 0,
									}),
								),
							{ once: true },
						);
					});
				};
				mod.updateAdminKey("old-admin-key");
				mod.connectionVerified.value = true;
				mod.importBatch.value = uiImportBatchText(81);

				const importing = mod.submitImport({ preventDefault() {} });
				await chunkStarted;
				mod.updateAdminKey("new-admin-key");
				await importing;

				assert.deepEqual(requestSizes, [81, 40]);
				assert.equal(activeChunkSignal.aborted, true);
				assert.equal(mod.connectionVerified.value, false);
			} finally {
				globalThis.fetch = originalFetch;
				if (originalWindow === undefined) delete globalThis.window;
				else globalThis.window = originalWindow;
				mod.importBatch.value = "";
				mod.updateAdminKey("");
			}
		},
	],
	[
		"marks a connection verified only after a valid slim overview loads",
		async () => {
			const originalFetch = globalThis.fetch;
			const originalWindow = globalThis.window;
			try {
				globalThis.window = { setTimeout: () => 0 };
				mod.adminKey.value = "admin-secret";
				mod.connectionVerified.value = false;
				mod.authExpanded.value = true;
				globalThis.fetch = async () =>
					Response.json({
						items: [],
						nextCursor: "cursor-2",
						limit: 200,
						stats: emptyStats(),
					});
				await mod.loadAccounts("reset", true);
				assert.equal(mod.connectionVerified.value, true);
				assert.equal(mod.authExpanded.value, false);
				await mod.loadAccounts("next");
				await mod.loadAccounts("prev");

				globalThis.fetch = async () =>
					Response.json({ items: [], nextCursor: null, limit: 200 });
				mod.modelRouting.value = uiModelRouting();
				await mod.loadAccounts("reset", true);
				assert.equal(mod.connectionVerified.value, false);
				assert.equal(mod.authExpanded.value, true);
				assert.equal(mod.modelRouting.value, null);
				assert.deepEqual(mod.modelRoutingDrafts.value.pro.routes, []);
				mod.adminKey.value = "";
				await mod.loadAccounts("reset", true);
			} finally {
				globalThis.fetch = originalFetch;
				if (originalWindow === undefined) delete globalThis.window;
				else globalThis.window = originalWindow;
				mod.adminKey.value = "";
				mod.connectionVerified.value = false;
				mod.authExpanded.value = false;
				mod.accounts.value = [];
				mod.accountStats.value = null;
			}
		},
	],
	[
		"serves the simplified admin UI without D1 reads or removed controls",
		async () => {
			let prepareCalls = 0;
			const env = {
				ADMIN_KEY: "admin-secret",
				GEMINI_DB: {
					prepare() {
						prepareCalls++;
						throw new Error("admin UI must not prepare D1 statements");
					},
				},
			};
			const response = await mod.default.fetch(
				new Request("https://worker.example/admin"),
				env,
				{},
			);
			assert.equal(response.status, 200);
			assert.equal(prepareCalls, 0);
			const html = await response.text();
			assert.match(html, /Gemini Account Pool/);
			assert.match(html, /Label or account ID/);
			assert.match(html, /All states/);
			assert.match(html, /Current issue/);
			assert.match(html, /primary-metrics/);
			assert.match(html, /Model route priority/);
			assert.match(html, /Reset to discovery order/);
			assert.doesNotMatch(
				html,
				/More filters|secondary-metrics|Export CSV|Diagnostics|Check selected|account_category|success_count/,
			);
			assert.doesNotMatch(
				html,
				/GEMINI_COOKIE|SAPISID=|SNlM0e=|Cookie:\s*__Secure/i,
			);
		},
	],
	[
		"parses bare dual-cookie imports and keeps account display logic minimal",
		() => {
			assert.deepEqual(
				mod.parseBatchImport("psid-a psidts-a First account\npsid-b,psidts-b"),
				[
					{ psid: "psid-a", psidts: "psidts-a", label: "First account" },
					{ psid: "psid-b", psidts: "psidts-b" },
				],
			);
			assert.throws(
				() => mod.parseBatchImport("__Secure-1PSID=secret psidts"),
				/value only/,
			);
			const account = uiAccount({
				label: "Alpha",
				state: "cooling",
				issue: "rate_limit",
				cooldown_until_ms: 61000,
			});
			assert.deepEqual(mod.identifier(account), { id: "account-a" });
			assert.equal(mod.identifierKey(account), "account-a");
			assert.equal(mod.accountDisplayName(account), "Alpha");
			assert.equal(mod.accountBusyLabel(""), "");
			assert.equal(mod.accountBusyLabel("refresh"), "Refresh in progress");
			assert.equal(
				mod.destructiveConfirmationText(1, "loaded account(s)").description,
				"This permanently deletes 1 loaded account. This action cannot be undone.",
			);
			assert.equal(
				mod.destructiveConfirmationText(2, "").confirmLabel,
				"Delete 2 accounts",
			);
			assert.equal(mod.isCooling(account), true);
			assert.equal(mod.relativeTime(61000, 1000), "in 1m");
			assert.equal(mod.relativeTime(3_601_000, 1000), "in 1h");
			assert.equal(mod.relativeTime(86_401_000, 1000), "in 1d");
		},
	],
];

function uiAccount(overrides = {}) {
	return {
		id: "account-a",
		label: null,
		enabled: true,
		state: "available",
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
		status_checked_at_ms: null,
		last_refresh_success_at_ms: null,
		created_at_ms: 1000,
		updated_at_ms: 1000,
		...overrides,
	};
}

function emptyStats(overrides = {}) {
	return {
		total: 0,
		available: 0,
		cooling: 0,
		attention: 0,
		disabled: 0,
		...overrides,
	};
}

function uiModelRouting() {
	return {
		version: "1",
		families: [
			{
				family: "pro",
				publicNames: ["gemini-3.1-pro", "gemini-3.1-pro-extended"],
				configured: false,
				routes: [
					{
						providerModelId: "9d8ca3786ebdfbea",
						capacity: 3,
						capacityField: 13,
						modelNumber: 3,
						label: null,
						available: true,
						configured: false,
						accountCount: 1,
					},
				],
			},
			{
				family: "flash",
				publicNames: ["gemini-3.5-flash", "gemini-3.5-flash-extended"],
				configured: false,
				routes: [],
			},
			{
				family: "flash_lite",
				publicNames: [
					"gemini-3.1-flash-lite",
					"gemini-3.1-flash-lite-extended",
				],
				configured: false,
				routes: [],
			},
		],
	};
}

function uiImportBatch(count) {
	return Array.from({ length: count }, (_value, index) => ({
		psid: `psid-${index}`,
		psidts: `psidts-${index}`,
		label: `account-${index}`,
	}));
}

function uiImportBatchText(count) {
	return uiImportBatch(count)
		.map((account) => `${account.psid} ${account.psidts} ${account.label}`)
		.join("\n");
}

function uiAdminApiSession(adminKey = "admin-secret") {
	const controller = new AbortController();
	return { adminKey, signal: controller.signal };
}
