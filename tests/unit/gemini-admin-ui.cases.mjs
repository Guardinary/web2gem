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
					"admin-secret",
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
						mod.createAccountsWithLimitFallback("admin-secret", {
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
				await mod.loadAccounts("reset", true);
				assert.equal(mod.connectionVerified.value, false);
				assert.equal(mod.authExpanded.value, true);
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

function uiImportBatch(count) {
	return Array.from({ length: count }, (_value, index) => ({
		psid: `psid-${index}`,
		psidts: `psidts-${index}`,
		label: `account-${index}`,
	}));
}
