import { beforeEach, describe, test } from "vitest";
import {
	loadAccounts,
	moveModelRoute,
	saveModelRoutePriority,
	submitImport,
	updateAdminKey,
} from "../../src/admin-ui/actions";
import {
	createAccountsWithLimitFallback,
	getModelRoutingOverview,
	replaceModelRoutePriority,
	resetModelRoutePriority,
} from "../../src/admin-ui/api";
import { detectLanguage } from "../../src/admin-ui/i18n";
import {
	accountBusyLabel,
	accountDisplayName,
	accountResourcePath,
	destructiveConfirmationText,
	identifier,
	identifierKey,
	isCooling,
	mergeMutationResults,
	parseBatchImport,
	relativeTime,
	resultSummary,
} from "../../src/admin-ui/logic";
import {
	isAccount,
	parseModelRoutingOverview,
	parseMutation,
	parseOverview,
} from "../../src/admin-ui/schemas";
import {
	accountStats,
	accounts,
	adminKey,
	authExpanded,
	connectionVerified,
	importBatch,
	importPsid,
	importPsidts,
	modelRouting,
	modelRoutingDrafts,
} from "../../src/admin-ui/state";
import { resolveTheme } from "../../src/admin-ui/theme";
import worker from "../../src/index";
import { assert } from "./assertions.js";
import { resetTestState } from "./helpers.js";

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
function uiAdminApiSession(sessionAdminKey = "admin-secret") {
	const controller = new AbortController();
	return { adminKey: sessionAdminKey, signal: controller.signal };
}

describe("gemini account admin UI", () => {
	beforeEach(resetTestState);
	test("resolves language and theme preferences without browser state", () => {
		assert.equal(detectLanguage("zh-CN"), "zh-CN");
		assert.equal(detectLanguage("en-US"), "en");
		assert.equal(resolveTheme("system", true), "dark");
		assert.equal(resolveTheme("system", false), "light");
		assert.equal(resolveTheme("light", true), "light");
	});
	test("uses strict slim account, overview, and mutation schemas", () => {
		const account = uiAccount();
		assert.equal(isAccount(account), true);
		assert.equal(isAccount({ ...account, cookie_hash: "secret" }), false);
		assert.equal(
			isAccount({
				id: "legacy",
				row_id: "legacy-row",
				status: "active",
				enabled: 1,
			}),
			false,
		);
		assert.deepEqual(
			parseOverview({
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
			() => parseMutation({ added: 1, skipped: 0 }),
			/admin mutation response is invalid/,
		);
		assert.deepEqual(
			parseMutation({
				processed: 2,
				changed: 1,
				unchanged: 1,
				failed: 0,
			}),
			{ processed: 2, changed: 1, unchanged: 1, failed: 0 },
		);
	});
	test("builds resource paths and merges compact mutation results", () => {
		assert.equal(
			accountResourcePath("account/a"),
			"/admin/accounts/account%2Fa",
		);
		assert.deepEqual(
			mergeMutationResults([
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
	test("validates and requests exact model routing DTOs", async () => {
		const overview = uiModelRouting();
		assert.deepEqual(parseModelRoutingOverview(overview), overview);
		assert.throws(
			() =>
				parseModelRoutingOverview({
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
				parseModelRoutingOverview({
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
			await getModelRoutingOverview(session);
			await replaceModelRoutePriority(session, "pro", [
				{
					providerModelId: "9d8ca3786ebdfbea",
					capacity: 3,
					capacityField: 13,
					modelNumber: 3,
				},
			]);
			await resetModelRoutePriority(session, "pro");
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
	});
	test("keeps model routing draft order separate from the saved overview", async () => {
		const overview = uiModelRouting();
		updateAdminKey("admin-secret");
		connectionVerified.value = true;
		modelRouting.value = overview;
		modelRoutingDrafts.value = {
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
		moveModelRoute("pro", 1, -1);
		assert.deepEqual(
			modelRoutingDrafts.value.pro.routes.map((route) => route.providerModelId),
			["e6fa609c3fa255c0", "9d8ca3786ebdfbea"],
		);
		assert.equal(modelRoutingDrafts.value.pro.dirty, true);
		assert.equal(
			modelRouting.value.families[0].routes[0].providerModelId,
			"9d8ca3786ebdfbea",
		);

		const originalFetch = globalThis.fetch;
		const originalWindow = globalThis.window;
		try {
			globalThis.window = { setTimeout: () => 0 };
			globalThis.fetch = async () => Response.json(overview);
			await saveModelRoutePriority("pro");
			assert.equal(
				modelRoutingDrafts.value.flash.routes[0].providerModelId,
				"56fdd199312815e2",
			);
			assert.equal(modelRoutingDrafts.value.flash.dirty, true);
			assert.equal(modelRoutingDrafts.value.pro.dirty, false);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalWindow === undefined) delete globalThis.window;
			else globalThis.window = originalWindow;
			updateAdminKey("");
		}
	});
	test("keeps the newest model routing snapshot across out-of-order family saves", async () => {
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
			updateAdminKey("admin-secret");
			connectionVerified.value = true;
			modelRouting.value = overview("8", proOld, flashOld);
			modelRoutingDrafts.value = {
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

			const proSave = saveModelRoutePriority("pro");
			const flashSave = saveModelRoutePriority("flash");
			pending.get("/admin/model-routing/flash")?.(
				Response.json(overview("10", proNew, flashNew)),
			);
			await flashSave;
			pending.get("/admin/model-routing/pro")?.(
				Response.json(overview("9", proNew, flashOld)),
			);
			await proSave;

			assert.equal(modelRouting.value.version, "10");
			assert.equal(
				modelRouting.value.families.find((family) => family.family === "flash")
					.routes[0].providerModelId,
				"flash-new",
			);
			assert.equal(
				modelRoutingDrafts.value.pro.routes[0].providerModelId,
				"pro-new",
			);
			assert.equal(
				modelRoutingDrafts.value.flash.routes[0].providerModelId,
				"flash-new",
			);
			assert.equal(modelRoutingDrafts.value.pro.busy, false);
			assert.equal(modelRoutingDrafts.value.pro.dirty, false);
			assert.equal(modelRoutingDrafts.value.flash.busy, false);
			assert.equal(modelRoutingDrafts.value.flash.dirty, false);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalWindow === undefined) delete globalThis.window;
			else globalThis.window = originalWindow;
			updateAdminKey("");
		}
	});
	test("invalidates all protected admin state when the credential changes", () => {
		const overview = uiModelRouting();
		adminKey.value = "old-admin-key";
		connectionVerified.value = true;
		authExpanded.value = false;
		accounts.value = [uiAccount()];
		accountStats.value = emptyStats({ total: 1, available: 1 });
		modelRouting.value = overview;
		modelRoutingDrafts.value = {
			pro: {
				routes: overview.families[0].routes,
				busy: true,
				error: null,
				dirty: true,
			},
			flash: { routes: [], busy: false, error: null, dirty: false },
			flash_lite: { routes: [], busy: false, error: null, dirty: false },
		};

		updateAdminKey("new-admin-key");

		assert.equal(adminKey.value, "new-admin-key");
		assert.equal(connectionVerified.value, false);
		assert.equal(authExpanded.value, true);
		assert.deepEqual(accounts.value, []);
		assert.equal(accountStats.value, null);
		assert.equal(modelRouting.value, null);
		assert.deepEqual(modelRoutingDrafts.value, {
			pro: { routes: [], busy: false, error: null, dirty: false },
			flash: { routes: [], busy: false, error: null, dirty: false },
			flash_lite: { routes: [], busy: false, error: null, dirty: false },
		});
	});
	test("discards an in-flight verification response after the credential changes", async () => {
		const originalFetch = globalThis.fetch;
		const originalWindow = globalThis.window;
		let resolveOverview;
		const pendingOverview = new Promise((resolve) => {
			resolveOverview = resolve;
		});
		try {
			globalThis.window = { setTimeout: () => 0 };
			globalThis.fetch = async () => pendingOverview;
			updateAdminKey("old-admin-key");
			const verification = loadAccounts("reset", true);
			await Promise.resolve();

			updateAdminKey("new-admin-key");
			resolveOverview(
				Response.json({
					items: [uiAccount()],
					nextCursor: null,
					limit: 200,
					stats: emptyStats({ total: 1, available: 1 }),
				}),
			);
			await verification;

			assert.equal(adminKey.value, "new-admin-key");
			assert.equal(connectionVerified.value, false);
			assert.deepEqual(accounts.value, []);
			assert.equal(accountStats.value, null);
			assert.equal(modelRouting.value, null);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalWindow === undefined) delete globalThis.window;
			else globalThis.window = originalWindow;
			updateAdminKey("");
		}
	});
	test("commits only the newest account overview within one admin session", async () => {
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
			updateAdminKey("admin-secret");
			connectionVerified.value = true;

			const first = loadAccounts();
			await Promise.resolve();
			const second = loadAccounts();
			await Promise.resolve();
			pending[1]?.(overview(2));
			await second;
			pending[0]?.(overview(1));
			await first;

			assert.equal(accountStats.value.total, 2);
			assert.equal(connectionVerified.value, true);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalWindow === undefined) delete globalThis.window;
			else globalThis.window = originalWindow;
			updateAdminKey("");
		}
	});
	test("invalidates the verified admin session when credentials are rejected", async () => {
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
			updateAdminKey("admin-secret");
			connectionVerified.value = true;
			authExpanded.value = false;
			accounts.value = [uiAccount()];
			accountStats.value = emptyStats({ total: 1, available: 1 });
			modelRouting.value = overview;
			modelRoutingDrafts.value = {
				pro: {
					routes: overview.families[0].routes,
					busy: false,
					error: null,
					dirty: true,
				},
				flash: { routes: [], busy: false, error: null, dirty: false },
				flash_lite: { routes: [], busy: false, error: null, dirty: false },
			};

			await loadAccounts();

			assert.equal(connectionVerified.value, false);
			assert.equal(authExpanded.value, true);
			assert.deepEqual(accounts.value, []);
			assert.equal(accountStats.value, null);
			assert.equal(modelRouting.value, null);
			assert.deepEqual(modelRoutingDrafts.value, {
				pro: { routes: [], busy: false, error: null, dirty: false },
				flash: { routes: [], busy: false, error: null, dirty: false },
				flash_lite: { routes: [], busy: false, error: null, dirty: false },
			});
		} finally {
			globalThis.fetch = originalFetch;
			if (originalWindow === undefined) delete globalThis.window;
			else globalThis.window = originalWindow;
			updateAdminKey("");
		}
	});
	test("invalidates the verified admin session when a mutation is rejected", async () => {
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
			updateAdminKey("admin-secret");
			connectionVerified.value = true;
			modelRouting.value = overview;
			modelRoutingDrafts.value = {
				pro: {
					routes: overview.families[0].routes,
					busy: false,
					error: null,
					dirty: true,
				},
				flash: { routes: [], busy: false, error: null, dirty: false },
				flash_lite: { routes: [], busy: false, error: null, dirty: false },
			};

			await saveModelRoutePriority("pro");

			assert.equal(connectionVerified.value, false);
			assert.equal(modelRouting.value, null);
			assert.deepEqual(modelRoutingDrafts.value.pro, {
				routes: [],
				busy: false,
				error: null,
				dirty: false,
			});
		} finally {
			globalThis.fetch = originalFetch;
			if (originalWindow === undefined) delete globalThis.window;
			else globalThis.window = originalWindow;
			updateAdminKey("");
		}
	});
	test("blocks account import until the admin session is verified", async () => {
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
			updateAdminKey("admin-secret");
			connectionVerified.value = false;
			importPsid.value = "psid-value";
			importPsidts.value = "psidts-value";

			await submitImport({ preventDefault() {} });

			assert.equal(requests, 0);
		} finally {
			globalThis.fetch = originalFetch;
			importPsid.value = "";
			importPsidts.value = "";
			importBatch.value = "";
			updateAdminKey("");
		}
	});
	test("retries only Worker-limited imports in ordered 40-account chunks", async () => {
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
			const result = await createAccountsWithLimitFallback(
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
	});
	test("does not retry unrelated or non-JSON import failures", async () => {
		const originalFetch = globalThis.fetch;
		let requests = 0;
		try {
			globalThis.fetch = async () => {
				requests++;
				return new Response("upstream failure", { status: 500 });
			};
			await assert.rejects(
				() =>
					createAccountsWithLimitFallback(uiAdminApiSession(), {
						accounts: uiImportBatch(81),
					}),
				/Request failed with status 500/,
			);
			assert.equal(requests, 1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
	test("aborts the full import request tree when the admin session changes", async () => {
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
			updateAdminKey("old-admin-key");
			connectionVerified.value = true;
			importBatch.value = uiImportBatchText(81);

			const importing = submitImport({ preventDefault() {} });
			await chunkStarted;
			updateAdminKey("new-admin-key");
			await importing;

			assert.deepEqual(requestSizes, [81, 40]);
			assert.equal(activeChunkSignal.aborted, true);
			assert.equal(connectionVerified.value, false);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalWindow === undefined) delete globalThis.window;
			else globalThis.window = originalWindow;
			importBatch.value = "";
			updateAdminKey("");
		}
	});
	test("marks a connection verified only after a valid slim overview loads", async () => {
		const originalFetch = globalThis.fetch;
		const originalWindow = globalThis.window;
		try {
			globalThis.window = { setTimeout: () => 0 };
			adminKey.value = "admin-secret";
			connectionVerified.value = false;
			authExpanded.value = true;
			globalThis.fetch = async () =>
				Response.json({
					items: [],
					nextCursor: "cursor-2",
					limit: 200,
					stats: emptyStats(),
				});
			await loadAccounts("reset", true);
			assert.equal(connectionVerified.value, true);
			assert.equal(authExpanded.value, false);
			await loadAccounts("next");
			await loadAccounts("prev");

			globalThis.fetch = async () =>
				Response.json({ items: [], nextCursor: null, limit: 200 });
			modelRouting.value = uiModelRouting();
			await loadAccounts("reset", true);
			assert.equal(connectionVerified.value, false);
			assert.equal(authExpanded.value, true);
			assert.equal(modelRouting.value, null);
			assert.deepEqual(modelRoutingDrafts.value.pro.routes, []);
			adminKey.value = "";
			await loadAccounts("reset", true);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalWindow === undefined) delete globalThis.window;
			else globalThis.window = originalWindow;
			adminKey.value = "";
			connectionVerified.value = false;
			authExpanded.value = false;
			accounts.value = [];
			accountStats.value = null;
		}
	});
	test("serves the simplified admin UI without D1 reads or removed controls", async () => {
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
		const response = await worker.fetch(
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
	});
	test("parses bare dual-cookie imports and keeps account display logic minimal", () => {
		assert.deepEqual(
			parseBatchImport("psid-a psidts-a First account\npsid-b,psidts-b"),
			[
				{ psid: "psid-a", psidts: "psidts-a", label: "First account" },
				{ psid: "psid-b", psidts: "psidts-b" },
			],
		);
		assert.throws(
			() => parseBatchImport("__Secure-1PSID=secret psidts"),
			/value only/,
		);
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
		assert.equal(
			destructiveConfirmationText(1, "loaded account(s)").description,
			"This permanently deletes 1 loaded account. This action cannot be undone.",
		);
		assert.equal(
			destructiveConfirmationText(2, "").confirmLabel,
			"Delete 2 accounts",
		);
		assert.equal(isCooling(account), true);
		assert.equal(relativeTime(61000, 1000), "in 1m");
		assert.equal(relativeTime(3_601_000, 1000), "in 1h");
		assert.equal(relativeTime(86_401_000, 1000), "in 1d");
	});
});
