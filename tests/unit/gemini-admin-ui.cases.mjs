import { assert } from "./assertions.js";
import { mod } from "./helpers.js";

export const suiteName = "gemini account admin UI";
export const cases = [
	[
		"admin UI resolves language and three-mode themes without browser state",
		() => {
			assert.equal(mod.detectLanguage("zh-CN"), "zh-CN");
			assert.equal(mod.detectLanguage("en-US"), "en");
			assert.equal(mod.resolveTheme("system", true), "dark");
			assert.equal(mod.resolveTheme("system", false), "light");
			assert.equal(mod.resolveTheme("light", true), "light");
		},
	],
	[
		"admin WebUI logic builds v2 resource paths and aggregates batch results",
		() => {
			assert.equal(
				mod.accountResourcePath("account/a"),
				"/admin/accounts/account%2Fa",
			);
			assert.equal(
				mod.accountResourcePath("account-a", "refresh"),
				"/admin/accounts/account-a/refresh",
			);
			assert.deepEqual(
				mod.mergeMutationResults([
					{ updated: 1, skipped: 0, items: [{ id: "account-a" }] },
					{
						updated: 1,
						skipped: 1,
						items: [{ id: "account-b" }],
						errors: [{ error: "safe" }],
					},
				]),
				{
					updated: 2,
					skipped: 1,
					errors: [{ error: "safe" }],
					items: [{ id: "account-a" }, { id: "account-b" }],
				},
			);
		},
	],
	[
		"admin UI retries only Worker-limited imports in ordered 40-account chunks",
		async () => {
			const originalFetch = globalThis.fetch;
			const requestSizes = [];
			try {
				globalThis.fetch = async (_path, init) => {
					const payload = JSON.parse(String(init?.body || "{}"));
					requestSizes.push(payload.accounts.length);
					if (requestSizes.length === 1) {
						return Response.json(
							{
								error: {
									message: "Worker import limit exceeded",
									code: "gemini_import_account_limit_exceeded",
								},
							},
							{ status: 413 },
						);
					}
					return Response.json({
						added: payload.accounts.length,
						duplicates: 0,
						skipped: 0,
					});
				};

				const result = await mod.createAccountsWithLimitFallback(
					"admin-secret",
					{ accounts: uiImportBatch(81) },
				);
				assert.deepEqual(requestSizes, [81, 40, 40, 1]);
				assert.deepEqual(result, { added: 81, duplicates: 0, skipped: 0 });
			} finally {
				globalThis.fetch = originalFetch;
			}
		},
	],
	[
		"admin UI keeps successful large Docker imports to one request",
		async () => {
			const originalFetch = globalThis.fetch;
			const requestSizes = [];
			try {
				globalThis.fetch = async (_path, init) => {
					const payload = JSON.parse(String(init?.body || "{}"));
					requestSizes.push(payload.accounts.length);
					return Response.json({ added: payload.accounts.length });
				};

				const result = await mod.createAccountsWithLimitFallback(
					"admin-secret",
					{ accounts: uiImportBatch(81) },
				);
				assert.deepEqual(requestSizes, [81]);
				assert.deepEqual(result, { added: 81 });
			} finally {
				globalThis.fetch = originalFetch;
			}
		},
	],
	[
		"admin UI does not retry non-limit import failures",
		async () => {
			const originalFetch = globalThis.fetch;
			let requestCount = 0;
			try {
				globalThis.fetch = async () => {
					requestCount += 1;
					return Response.json(
						{
							error: {
								message: "safe failure",
								code: "admin_request_failed",
							},
						},
						{ status: 500 },
					);
				};

				await assert.rejects(
					() =>
						mod.createAccountsWithLimitFallback("admin-secret", {
							accounts: uiImportBatch(81),
						}),
					/safe failure/,
				);
				assert.equal(requestCount, 1);
			} finally {
				globalThis.fetch = originalFetch;
			}
		},
	],
	[
		"admin UI marks a connection verified only after account loading succeeds",
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
						nextCursor: null,
						limit: 200,
						stats: {
							total: 0,
							available: 0,
							needsAttention: 0,
							disabled: 0,
							refreshable: 0,
							cooling: 0,
							psidOnly: 0,
							successCount: 0,
							failureCount: 0,
						},
					});

				await mod.loadAccounts("reset", true);
				assert.equal(mod.connectionVerified.value, true);
				assert.equal(mod.authExpanded.value, false);

				mod.accounts.value = [{ id: "stale-account" }];
				mod.accountStats.value = { total: 1 };
				globalThis.fetch = async () =>
					Response.json(
						{ error: { message: "invalid admin key" } },
						{ status: 401 },
					);

				await mod.loadAccounts("reset", true);
				assert.equal(mod.connectionVerified.value, false);
				assert.equal(mod.authExpanded.value, true);
				assert.deepEqual(mod.accounts.value, []);
				assert.equal(mod.accountStats.value, null);
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
		"admin UI rejects connection verification without an admin key",
		async () => {
			const originalWindow = globalThis.window;
			try {
				globalThis.window = { setTimeout: () => 0 };
				mod.adminKey.value = "";
				mod.connectionVerified.value = true;
				mod.authExpanded.value = false;

				await mod.loadAccounts("reset", true);

				assert.equal(mod.connectionVerified.value, false);
				assert.equal(mod.authExpanded.value, true);
			} finally {
				if (originalWindow === undefined) delete globalThis.window;
				else globalThis.window = originalWindow;
				mod.adminKey.value = "";
				mod.connectionVerified.value = false;
				mod.authExpanded.value = false;
			}
		},
	],
	[
		"worker serves Gemini account admin WebUI without D1 reads or legacy cookie fallback text",
		async () => {
			let prepareCalls = 0;
			const env = {
				API_KEYS: "public-key",
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
			assert.match(response.headers.get("content-type") || "", /text\/html/);
			assert.match(
				response.headers.get("content-security-policy") || "",
				/frame-ancestors 'none'/,
			);
			assert.match(
				response.headers.get("referrer-policy") || "",
				/no-referrer/,
			);
			assert.equal(prepareCalls, 0);
			const html = await response.text();
			assert.match(html, /Gemini Account Pool/);
			assert.match(html, /\/admin\/accounts/);
			assert.match(html, /__Secure-1PSID/);
			assert.match(html, /__Secure-1PSIDTS/);
			assert.match(html, /More filters/);
			assert.match(html, /secondary-metrics/);
			assert.match(html, /skeleton-row/);
			assert.match(html, /aria-busy/);
			assert.match(html, /inert/);
			assert.doesNotMatch(
				html,
				/GEMINI_COOKIE|SAPISID=|SNlM0e=|psid-secret|ts-secret|Cookie:\s*__Secure/i,
			);

			const post = await mod.default.fetch(
				new Request("https://worker.example/admin", { method: "POST" }),
				env,
				{},
			);
			assert.equal(post.status, 404);
			assert.equal(prepareCalls, 0);
		},
	],
	[
		"admin UI pure logic parses safe batch imports and rejects cookie headers",
		() => {
			assert.deepEqual(
				mod.parseBatchImport("psid-a psidts-a First account\npsid-b,psidts-b"),
				[
					{ psid: "psid-a", psidts: "psidts-a", label: "First account" },
					{ psid: "psid-b", psidts: "psidts-b" },
				],
			);
			assert.equal(mod.parseBatchImport("   ").length, 0);
			assert.throws(
				() => mod.parseBatchImport("__Secure-1PSID=secret psidts"),
				/value only/,
			);
			assert.throws(
				() => mod.validateCookieValue("secret; other", "cookie"),
				/value only/,
			);
		},
	],
	[
		"admin UI pure logic keeps identifiers summaries and CSV sanitized",
		() => {
			const account = {
				id: "account-a",
				row_id: "row-a",
				label: 'A "quoted" account',
				enabled: 1,
				status: "active",
				account_category: "full_session",
				has_cookie: true,
				has_sapisid: true,
				has_session_token: false,
				cooldown_until_ms: 2000,
			};
			assert.deepEqual(mod.identifier(account), { id: "account-a" });
			assert.equal(mod.identifierKey(account), "account-a");
			assert.equal(mod.accountDisplayName(account), 'A "quoted" account');
			assert.equal(mod.accountBusyLabel("refresh"), "Refresh in progress");
			assert.deepEqual(
				mod.destructiveConfirmationText(2, "selected accounts"),
				{
					title: "Delete 2 accounts?",
					description:
						"This permanently deletes 2 selected accounts. This action cannot be undone.",
					confirmLabel: "Delete 2 accounts",
				},
			);
			assert.equal(
				mod.destructiveConfirmationText(1, "loaded account(s)").description,
				"This permanently deletes 1 loaded account. This action cannot be undone.",
			);
			assert.equal(mod.sessionLabel(account), "cookie / sapisid");
			assert.equal(mod.isRefreshable(account), true);
			assert.equal(mod.isCooling(account, 1000), true);
			assert.equal(mod.relativeTime(61000, 1000), "in 1m");
			assert.equal(
				mod.resultSummary("refresh", {
					checked: 2,
					refreshed: 1,
					errors: [{ error: "safe failure" }],
				}),
				"refresh completed: checked 2, refreshed 1 - safe failure",
			);
			const csv = mod.metadataCsv([account]);
			assert.match(csv, /^id,row_id,label,enabled,status,/);
			assert.match(csv, /"A ""quoted"" account"/);
			assert.doesNotMatch(csv, /cookie_header|session_token/);
		},
	],
];

function uiImportBatch(count) {
	return Array.from({ length: count }, (_value, index) => ({
		psid: `psid-${index}`,
		psidts: `psidts-${index}`,
		label: `account-${index}`,
	}));
}
