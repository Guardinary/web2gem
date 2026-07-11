import { assert } from "./assertions.js";
import { baseConfig, mod } from "./helpers.js";

export const suiteName = "gemini accounts";
export const cases = [
	[
		"lists selectable accounts with bounded indexed query shape and sanitized admin rows",
		async () => {
			const db = new FakeD1();
			const store = new mod.D1GeminiAccountStore(db);
			await seedAccount(store, "a", {
				label: "A",
				cookieHeader:
					"__Secure-1PSID=psid-a; __Secure-1PSIDTS=ts-a; SNlM0e=secret",
				sessionToken: "at-a",
				nowMs: 1000,
			});
			await seedAccount(store, "b", {
				cookieHeader: "__Secure-1PSID=psid-b; __Secure-1PSIDTS=ts-b",
				nowMs: 1100,
			});
			db.rows.get("b").cooldown_until_ms = 5000;
			await seedAccount(store, "c", {
				cookieHeader: "__Secure-1PSID=psid-c; __Secure-1PSIDTS=ts-c",
				nowMs: 1200,
			});
			db.rows.get("c").enabled = 0;

			const rows = await store.listSelectableAccounts(2000, 5000);
			assert.deepEqual(
				rows.map((row) => row.id),
				["a"],
			);
			assert.equal(db.lastBindValue(), 200);
			const sql = db.lastSql();
			assert.match(sql, /WHERE enabled = 1/);
			assert.match(sql, /status IN \(\?, \?, \?, \?\)/);
			assert.match(sql, /cooldown_until_ms IS NULL OR cooldown_until_ms <= \?/);
			assert.match(sql, /LIMIT \?/);

			const page = await store.listAdminAccounts({ limit: 10 });
			const account = page.items.find((item) => item.id === "a");
			assert.equal(account.has_cookie, true);
			assert.equal(account.has_sapisid, false);
			assert.equal(account.has_session_token, true);
			assert.equal(Object.hasOwn(account, "cookie_header"), false);
			assert.equal(Object.hasOwn(account, "session_token"), false);
			assert.equal(Object.hasOwn(account, "sapisid"), false);
			assert.doesNotMatch(JSON.stringify(account), /psid-a|at-a|SNlM0e/);
		},
	],
	[
		"skips unchanged cookie writeback and increments pool version only for durable state changes",
		async () => {
			const db = new FakeD1();
			const store = new mod.D1GeminiAccountStore(db);
			await seedAccount(store, "acct", {
				cookieHeader: "__Secure-1PSID=psid; __Secure-1PSIDTS=ts",
				sessionToken: "at-1",
				nowMs: 1000,
			});
			assert.equal(await store.getPoolVersion(), "1000");

			const noChange = await store.writeCookieState("acct", {
				cookieHeader: "__Secure-1PSID=psid; __Secure-1PSIDTS=ts",
				nowMs: 2000,
			});
			assert.deepEqual(noChange, { changed: false });
			assert.equal(await store.getPoolVersion(), "1000");
			assert.equal(
				db.rows.get("acct").session_token_hash,
				await mod.hashNullable("at-1"),
			);

			const writeResult = await store.writeCookieState("acct", {
				cookieHeader:
					"__Secure-1PSID=psid; __Secure-1PSIDTS=ts2; SNlM0e=must-not-enter-cookie",
				sessionToken: "at-2",
				nowMs: 3000,
			});
			assert.deepEqual(writeResult, { changed: true });
			assert.equal(await store.getPoolVersion(), "3000");
			assert.doesNotMatch(
				db.rows.get("acct").cookie_header,
				/SNlM0e|must-not-enter-cookie/,
			);

			await store.writeAccountOutcome("acct", { kind: "success", nowMs: 4000 });
			assert.equal(await store.getPoolVersion(), "3000");
			assert.equal(db.rows.get("acct").success_count, 1);
			assert.equal(db.rows.get("acct").last_used_at_ms, 4000);

			await store.writeAccountOutcome("acct", {
				kind: "failure",
				status: "rate_limited",
				cooldownUntilMs: 9000,
				failureKind: "rate_limit",
				nowMs: 5000,
			});
			assert.equal(await store.getPoolVersion(), "5000");
			assert.equal(db.rows.get("acct").status, "rate_limited");
			assert.equal(db.rows.get("acct").failure_count, 1);
		},
	],
	[
		"treats cookie writeback convergence as a duplicate instead of failing",
		async () => {
			const db = new FakeD1();
			const store = new mod.D1GeminiAccountStore(db);
			await seedAccount(store, "stale", {
				cookieHeader: "__Secure-1PSID=psid; __Secure-1PSIDTS=ts-old",
				nowMs: 1000,
			});
			await seedAccount(store, "current", {
				cookieHeader: "__Secure-1PSID=psid; __Secure-1PSIDTS=ts-current",
				nowMs: 1100,
			});
			const originalHash = db.rows.get("stale").cookie_hash;
			const currentHeader = db.rows.get("current").cookie_header;
			db.hiddenCookieHashLookups = 1;

			const result = await store.writeCookieState("stale", {
				cookieHeader: currentHeader,
				lastRefreshAtMs: 2000,
				nowMs: 2000,
			});

			assert.deepEqual(result, { changed: false, reason: "duplicate_cookie" });
			assert.equal(db.rows.get("stale").cookie_hash, originalHash);
			assert.equal(db.rows.get("stale").last_refresh_at_ms, null);
			assert.equal(await store.getPoolVersion(), "1100");
		},
	],
	[
		"acquires refresh locks with conflict, expiry replacement, and owner release",
		async () => {
			const db = new FakeD1();
			const store = new mod.D1GeminiAccountStore(db);
			assert.equal(
				await store.tryAcquireRefreshLock("acct", "owner-a", 2000, 1000),
				true,
			);
			assert.equal(
				await store.tryAcquireRefreshLock("acct", "owner-b", 3000, 1500),
				false,
			);
			assert.equal(db.locks.get("acct").lock_owner, "owner-a");
			assert.equal(
				await store.tryAcquireRefreshLock("acct", "owner-b", 4000, 2500),
				true,
			);
			assert.equal(db.locks.get("acct").lock_owner, "owner-b");
			await store.releaseRefreshLock("acct", "owner-a");
			assert.equal(db.locks.has("acct"), true);
			await store.releaseRefreshLock("acct", "owner-b");
			assert.equal(db.locks.has("acct"), false);
		},
	],
	[
		"admin service accepts only safe Gemini dual-cookie imports and sanitizes create output",
		async () => {
			const db = new FakeD1();
			const service = mod.createGeminiAccountAdminServiceFromD1(
				db,
				baseConfig(),
				{ nowMs: () => 1000 },
			);
			const created = await service.create({
				provider: "gemini",
				accounts: [
					{
						provider: "gemini",
						"__Secure-1PSID": "psid-secret",
						"__Secure-1PSIDTS": "ts-secret",
						label: "primary",
					},
				],
			});
			assert.equal(created.added, 1);
			assert.equal(created.skipped, 0);
			assert.equal(created.items[0].label, "primary");
			assert.equal(created.items[0].has_cookie, true);
			assert.equal(Object.hasOwn(created.items[0], "cookie_header"), false);
			assert.doesNotMatch(
				JSON.stringify(created),
				/psid-secret|ts-secret|SAPISID|SNlM0e/,
			);

			const duplicate = await service.create({
				provider: "gemini",
				accounts: [
					{
						provider: "gemini",
						"__Secure-1PSID": "psid-secret",
						"__Secure-1PSIDTS": "ts-secret",
						label: "duplicate",
					},
				],
			});
			assert.equal(duplicate.added, 0);
			assert.equal(duplicate.skipped, 1);
			assert.equal(duplicate.duplicates, 1);
			assert.equal(duplicate.items[0].label, "primary");

			const invalidPayloads = [
				{ provider: "gemini", tokens: ["raw-token"] },
				{
					provider: "gpt",
					accounts: [
						{
							provider: "gemini",
							"__Secure-1PSID": "a",
							"__Secure-1PSIDTS": "b",
						},
					],
				},
				{
					provider: "gemini",
					accounts: [
						{ provider: "gpt", "__Secure-1PSID": "a", "__Secure-1PSIDTS": "b" },
					],
				},
				{
					provider: "gemini",
					accounts: [
						{
							"__Secure-1PSID": "a",
							"__Secure-1PSIDTS": "b",
							access_token: "secret",
						},
					],
				},
				{
					provider: "gemini",
					accounts: [
						{ "__Secure-1PSID": "__Secure-1PSID=a", "__Secure-1PSIDTS": "b" },
					],
				},
				{
					provider: "gemini",
					accounts: [{ "__Secure-1PSID": "a;b", "__Secure-1PSIDTS": "c" }],
				},
				{
					provider: "gemini",
					accounts: [{ "__Secure-1PSID": "a", "__Secure-1PSIDTS": "c=d" }],
				},
				{
					provider: "gemini",
					accounts: [
						{
							"__Secure-1PSID": '{"__Secure-1PSID":"a"}',
							"__Secure-1PSIDTS": "b",
						},
					],
				},
				{
					provider: "gemini",
					accounts: [
						{ "__Secure-1PSID": "__Secure-1PSID", "__Secure-1PSIDTS": "b" },
					],
				},
				{
					provider: "gemini",
					accounts: [
						{
							"__Secure-1PSID": "a",
							"__Secure-1PSIDTS": "b",
							cookies: { x: "y" },
						},
					],
				},
			];
			for (const payload of invalidPayloads) {
				await assert.rejects(
					() => service.create(payload),
					/Gemini|provider|cookie/i,
				);
			}
		},
	],
	[
		"admin input owner strictly normalizes filters and update payloads",
		() => {
			const accounts = mod.normalizeCreateAccounts({
				provider: "gemini",
				accounts: [
					{
						provider: "gemini",
						"__Secure-1PSID": "psid",
						"__Secure-1PSIDTS": "psidts",
						label: "primary",
					},
				],
			});
			assert.equal(accounts.length, 1);
			assert.deepEqual(
				mod.createGeminiAccountInputFromAdmin(accounts[0], 1234),
				{
					cookieHeader: "__Secure-1PSID=psid; __Secure-1PSIDTS=psidts",
					label: "primary",
					nowMs: 1234,
				},
			);
			assert.deepEqual(
				mod.normalizeGeminiAccountListFilter({
					limit: 999,
					q: " q ",
					category: "full_session",
					cooldown: "active",
				}),
				{
					limit: 200,
					q: "q",
					category: "full_session",
					cooldown: "active",
				},
			);
			const update = mod.geminiAccountUpdateFromAdminBody(
				{ label: " next ", enabled: true, source: "" },
				2000,
			);
			assert.deepEqual(update, {
				label: "next",
				enabled: true,
				source: null,
				nowMs: 2000,
			});
			assert.equal(mod.hasAccountUpdate(update), true);
			assert.equal(mod.hasAccountUpdate({ nowMs: 2000 }), false);
			assert.throws(
				() => mod.geminiAccountUpdateFromAdminBody({ enabled: "false" }, 2000),
				/enabled must be a boolean/,
			);
			assert.throws(
				() =>
					mod.geminiAccountUpdateFromAdminBody(
						{ id: "legacy-body-id", label: "x" },
						2000,
					),
				/unsupported account update field: id/,
			);
			assert.deepEqual(
				mod.geminiAccountListFilterFromSearchParams(
					new URLSearchParams("limit=25&enabled=false&category=full_session"),
				),
				{ limit: 25, enabled: false, category: "full_session" },
			);
			assert.throws(
				() =>
					mod.geminiAccountListFilterFromSearchParams(
						new URLSearchParams("enabled=yes"),
					),
				/enabled must be true, false, 1, or 0/,
			);
		},
	],
	[
		"admin service keeps resource mutations idempotent and path-id based",
		async () => {
			const db = new FakeD1();
			const store = new mod.D1GeminiAccountStore(db);
			await seedAccount(store, "a", {
				cookieHeader: "__Secure-1PSID=psid-a; __Secure-1PSIDTS=ts-a",
				nowMs: 1000,
			});
			await seedAccount(store, "b", {
				cookieHeader: "__Secure-1PSID=psid-b; __Secure-1PSIDTS=ts-b",
				nowMs: 1100,
			});
			const service = mod.createGeminiAccountAdminServiceFromD1(
				db,
				baseConfig(),
				{ nowMs: () => 2000 },
			);
			const page = await service.list({ limit: 500, enabled: true });
			assert.equal(page.limit, 200);
			assert.deepEqual(
				page.items.map((item) => item.id),
				["a", "b"],
			);

			db.rows.get("a").account_category = "psid_only";
			db.rows.get("a").source = "alpha-source";
			db.rows.get("a").cooldown_until_ms = 9_999_999_999_999;
			const filtered = await service.list({
				limit: 10,
				q: "alpha",
				category: "psid_only",
				cooldown: "cooling",
				source: "alpha-source",
			});
			assert.deepEqual(
				filtered.items.map((item) => item.id),
				["a"],
			);
			const stats = await service.stats({
				category: "psid_only",
				source: "alpha-source",
			});
			assert.equal(stats.total, 1);
			assert.equal(stats.psidOnly, 1);

			const firstPage = await service.list({ limit: 1 });
			assert.deepEqual(
				firstPage.items.map((item) => item.id),
				["a"],
			);
			assert.equal(firstPage.nextCursor, "a");
			const secondPage = await service.list({
				limit: 1,
				cursor: firstPage.nextCursor,
			});
			assert.deepEqual(
				secondPage.items.map((item) => item.id),
				["b"],
			);
			assert.equal(secondPage.nextCursor, null);

			const disabled = await service.update("a", { enabled: false });
			assert.equal(disabled.updated, 1);
			assert.equal(db.rows.get("a").enabled, 0);
			const disabledAgain = await service.update("a", { enabled: false });
			assert.equal(disabledAgain.updated, 1);
			assert.equal(db.rows.get("a").enabled, 0);

			const removed = await service.delete("b");
			assert.equal(removed.removed, 1);
			assert.equal(db.rows.has("b"), false);
			await assert.rejects(
				() => service.delete("missing"),
				/account not found/,
			);
		},
	],
	[
		"admin refresh and check preserve sanitized single-resource diagnostics",
		async () => {
			const db = new FakeD1();
			const store = new mod.D1GeminiAccountStore(db);
			await seedAccount(store, "refreshable", {
				cookieHeader: "__Secure-1PSID=psid-refresh; __Secure-1PSIDTS=ts-old",
				nowMs: 1000,
			});
			await seedAccount(store, "skipped", {
				cookieHeader: "__Secure-1PSID=psid-skip; __Secure-1PSIDTS=ts-skip",
				nowMs: 1000,
			});
			db.rows.get("skipped").account_category = "psid_only";

			let rotateCalls = 0;
			const service = mod.createGeminiAccountAdminServiceFromD1(
				db,
				baseConfig({
					request_timeout_sec: 10,
					upstream_socket: false,
				}),
				{
					nowMs: () => 120_000,
					rotateCookie: async () => {
						rotateCalls++;
						return new Response("", {
							status: 200,
							headers: {
								"set-cookie": "__Secure-1PSIDTS=ts-new; Path=/; Secure",
							},
						});
					},
				},
			);
			const result = await service.refresh("refreshable");
			assert.equal(result.checked, 1);
			assert.equal(result.refreshed, 1);
			assert.equal(result.skipped, 0);
			assert.equal(result.failed, 0);
			assert.equal(rotateCalls, 1);
			assert.doesNotMatch(
				JSON.stringify(result),
				/psid-refresh|ts-old|ts-new|SNlM0e|SAPISID/,
			);

			const skipped = await service.refresh("skipped");
			assert.equal(skipped.checked, 1);
			assert.equal(skipped.skipped, 1);
			const check = await service.check("refreshable");
			assert.equal(check.checked, 1);
			assert.equal(check.unchanged + check.refreshed, 1);
			await assert.rejects(() => service.check("missing"), /account not found/);

			await seedAccount(store, "failure", {
				cookieHeader:
					"__Secure-1PSID=psid-failure; __Secure-1PSIDTS=ts-failure",
				nowMs: 1000,
			});
			const failingService = mod.createGeminiAccountAdminServiceFromD1(
				db,
				baseConfig(),
				{
					nowMs: () => 130_000,
					rotateCookie: async () => {
						throw new Error("SQL cookie secret should stay internal");
					},
				},
			);
			const failed = await failingService.refresh("failure");
			assert.equal(failed.failed, 1);
			assert.equal(failed.errors[0].error, "admin_diagnostic_failed");
			assert.doesNotMatch(JSON.stringify(failed), /SQL|cookie secret/);
		},
	],
	[
		"worker admin route uses admin auth separately from public API keys and avoids unauthenticated D1 reads",
		async () => {
			const db = new FakeD1();
			let prepareCalls = 0;
			const env = {
				API_KEYS: "public-key",
				ADMIN_KEY: "admin-secret",
				GEMINI_DB: {
					prepare(sql) {
						prepareCalls++;
						return db.prepare(sql);
					},
				},
			};

			const publicKey = await mod.default.fetch(
				new Request("https://worker.example/admin/accounts", {
					headers: { Authorization: "Bearer public-key" },
				}),
				env,
				{},
			);
			assert.equal(publicKey.status, 401);
			assert.equal(prepareCalls, 0);

			const missingD1 = await mod.default.fetch(
				new Request("https://worker.example/admin/accounts", {
					headers: { Authorization: "Bearer admin-secret" },
				}),
				{ ADMIN_KEY: "admin-secret" },
				{},
			);
			assert.equal(missingD1.status, 503);
			assert.equal(
				(await missingD1.json()).error.code,
				"gemini_account_store_unavailable",
			);

			const created = await mod.default.fetch(
				new Request("https://worker.example/admin/accounts", {
					method: "POST",
					headers: {
						Authorization: "Bearer admin-secret",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						provider: "gemini",
						accounts: [
							{
								"__Secure-1PSID": "route-psid",
								"__Secure-1PSIDTS": "route-ts",
							},
						],
					}),
				}),
				env,
				{},
			);
			assert.equal(created.status, 200);
			assert.doesNotMatch(
				JSON.stringify(await created.json()),
				/route-psid|route-ts/,
			);

			const listed = await mod.default.fetch(
				new Request("https://worker.example/admin/accounts?limit=200", {
					headers: { "X-Admin-Key": "admin-secret" },
				}),
				env,
				{},
			);
			assert.equal(listed.status, 200);
			const body = await listed.json();
			assert.equal(body.limit, 200);
			assert.equal(body.items.length, 1);

			const stats = await mod.default.fetch(
				new Request("https://worker.example/admin/accounts/stats", {
					headers: { "X-Admin-Key": "admin-secret" },
				}),
				env,
				{},
			);
			assert.equal(stats.status, 200);
			assert.equal((await stats.json()).total, 1);
		},
	],
	[
		"worker enforces the account admin v2 route auth validation and error contract",
		async () => {
			const db = new FakeD1();
			const env = {
				ADMIN_KEY: "admin-secret",
				GEMINI_DB: db,
			};
			const adminHeaders = {
				Authorization: "Bearer admin-secret",
				"Content-Type": "application/json",
			};
			const created = await mod.default.fetch(
				new Request("https://worker.example/admin/accounts", {
					method: "POST",
					headers: adminHeaders,
					body: JSON.stringify({
						provider: "gemini",
						"__Secure-1PSID": "v2-psid",
						"__Secure-1PSIDTS": "v2-ts",
					}),
				}),
				env,
				{},
			);
			const id = (await created.json()).items[0].id;
			const resource = `https://worker.example/admin/accounts/${encodeURIComponent(id)}`;

			for (const enabled of [false, false, true]) {
				const response = await mod.default.fetch(
					new Request(resource, {
						method: "PATCH",
						headers: adminHeaders,
						body: JSON.stringify({ enabled }),
					}),
					env,
					{},
				);
				assert.equal(response.status, 200);
				assert.equal((await response.json()).items[0].enabled, enabled ? 1 : 0);
			}

			for (const action of ["refresh", "check"]) {
				db.rows.get(id).account_category = "psid_only";
				const response = await mod.default.fetch(
					new Request(`${resource}/${action}`, {
						method: "POST",
						headers: { Authorization: "Bearer admin-secret" },
					}),
					env,
					{},
				);
				assert.equal(response.status, 200);
				assert.equal((await response.json()).skipped, 1);
			}

			for (const [path, method] of [
				["/admin/accounts/update", "POST"],
				["/admin/accounts/enable", "POST"],
				["/admin/accounts/disable", "POST"],
				["/admin/accounts/refresh", "POST"],
				["/admin/accounts/check", "POST"],
				["/admin/accounts", "PATCH"],
				["/admin/accounts", "DELETE"],
			]) {
				const response = await mod.default.fetch(
					new Request(`https://worker.example${path}`, {
						method,
						headers: adminHeaders,
						body: method === "DELETE" ? undefined : "{}",
					}),
					env,
					{},
				);
				assert.equal(response.status, 404, `${method} ${path}`);
			}

			const publicHeader = await mod.default.fetch(
				new Request("https://worker.example/admin/accounts", {
					headers: { "x-api-key": "admin-secret" },
				}),
				env,
				{},
			);
			assert.equal(publicHeader.status, 401);

			for (const query of [
				"limit=999",
				"enabled=yes",
				"status=unknown",
				"unknown=value",
				"limit=10&limit=20",
			]) {
				const response = await mod.default.fetch(
					new Request(`https://worker.example/admin/accounts?${query}`, {
						headers: { "X-Admin-Key": "admin-secret" },
					}),
					env,
					{},
				);
				assert.equal(response.status, 400, query);
			}
			const mutationQuery = await mod.default.fetch(
				new Request(`${resource}?unexpected=1`, {
					method: "PATCH",
					headers: adminHeaders,
					body: JSON.stringify({ enabled: true }),
				}),
				env,
				{},
			);
			assert.equal(mutationQuery.status, 400);
			const actionBody = await mod.default.fetch(
				new Request(`${resource}/check`, {
					method: "POST",
					headers: adminHeaders,
					body: JSON.stringify({ id }),
				}),
				env,
				{},
			);
			assert.equal(actionBody.status, 400);
			assert.equal(
				(await actionBody.json()).error.code,
				"admin_request_body_not_allowed",
			);

			const removed = await mod.default.fetch(
				new Request(resource, {
					method: "DELETE",
					headers: { Authorization: "Bearer admin-secret" },
				}),
				env,
				{},
			);
			assert.equal(removed.status, 200);
			const missing = await mod.default.fetch(
				new Request(resource, {
					method: "DELETE",
					headers: { Authorization: "Bearer admin-secret" },
				}),
				env,
				{},
			);
			assert.equal(missing.status, 404);
			assert.equal((await missing.json()).error.code, "account_not_found");

			const internal = await mod.default.fetch(
				new Request("https://worker.example/admin/accounts", {
					headers: { Authorization: "Bearer admin-secret" },
				}),
				{
					ADMIN_KEY: "admin-secret",
					GEMINI_DB: {
						prepare() {
							throw new Error("SQL secret-cookie-fragment");
						},
					},
				},
				{},
			);
			assert.equal(internal.status, 500);
			const internalBody = await internal.json();
			assert.deepEqual(internalBody, {
				error: {
					message: "admin request failed",
					code: "admin_request_failed",
				},
			});
			assert.doesNotMatch(JSON.stringify(internalBody), /SQL|secret-cookie/);
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
					{ updated: 1, skipped: 0 },
					{ updated: 1, skipped: 1, errors: [{ error: "safe" }] },
				]),
				{ updated: 2, skipped: 1, errors: [{ error: "safe" }] },
			);
		},
	],
	[
		"worker serves Gemini account admin WebUI without D1 reads or legacy cookie fallback text",
		async () => {
			const db = new FakeD1();
			let prepareCalls = 0;
			const env = {
				API_KEYS: "public-key",
				ADMIN_KEY: "admin-secret",
				GEMINI_DB: {
					prepare(sql) {
						prepareCalls++;
						return db.prepare(sql);
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
			assert.match(html, /Authorization:\s*`Bearer \$\{[^}]+\}`/);
			assert.match(html, /__Secure-1PSID/);
			assert.match(html, /__Secure-1PSIDTS/);
			assert.match(html, /id:"category-filter"/);
			assert.match(html, /id:"cooldown-filter"/);
			assert.match(html, /id:"edit-form"/);
			assert.match(html, /id:"export-metadata"/);
			assert.match(html, /id:"next-page"/);
			assert.match(html, /sessionStorage/);
			assert.match(html, /stats\?/);
			assert.match(html, /duplicates/);
			assert.match(html, /Delete loaded/);
			assert.doesNotMatch(html, /Delete filtered/);
			assert.match(html, /success_count/);
			assert.match(html, /failure_count/);
			assert.match(html, /encodeURIComponent/);
			assert.match(html, /method:"PATCH"/);
			assert.doesNotMatch(
				html,
				/\/admin\/accounts\/(?:update|enable|disable|refresh|check)|x-api-key/,
			);
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

async function seedAccount(store, id, input) {
	return store.createAccount({
		id,
		label: null,
		...input,
	});
}

const ACCOUNT_COLUMNS = [
	"id",
	"label",
	"enabled",
	"status",
	"state_reason",
	"row_id",
	"cookie_header",
	"cookie_hash",
	"sapisid",
	"session_token",
	"session_token_hash",
	"session_id",
	"language",
	"push_id",
	"last_token_bootstrap_at_ms",
	"secure_1psid_hash",
	"secure_1psidts_hash",
	"account_category",
	"account_status_code",
	"account_status_description",
	"user_agent",
	"gemini_origin",
	"source",
	"source_id",
	"source_name",
	"imported_at_ms",
	"cooldown_until_ms",
	"last_used_at_ms",
	"last_success_at_ms",
	"last_failure_at_ms",
	"last_refresh_at_ms",
	"last_refresh_attempt_at_ms",
	"last_error_code",
	"last_error_message_redacted",
	"last_upstream_status",
	"last_capability_probe_at_ms",
	"capability_summary_json",
	"success_count",
	"failure_count",
	"created_at_ms",
	"updated_at_ms",
];

class FakeD1 {
	constructor() {
		this.rows = new Map();
		this.meta = new Map([["pool_version", { value: "0", updated_at_ms: 0 }]]);
		this.locks = new Map();
		this.statements = [];
		this.hiddenCookieHashLookups = 0;
	}

	prepare(sql) {
		return new FakeStatement(this, sql);
	}

	lastSql() {
		return this.statements.at(-1)?.sql || "";
	}

	lastBindValue() {
		return this.statements.at(-1)?.values.at(-1);
	}
}

class FakeStatement {
	constructor(db, sql, values = []) {
		this.db = db;
		this.sql = String(sql || "");
		this.values = values;
	}

	bind(...values) {
		return new FakeStatement(this.db, this.sql, values);
	}

	async first(columnName) {
		const result = await this.all();
		const row = result.results[0] || null;
		if (!row || columnName === undefined) return row;
		return Object.hasOwn(row, columnName) ? row[columnName] : null;
	}

	async all() {
		this.record();
		if (this.sql.includes("FROM gemini_pool_meta")) {
			return {
				results: [this.db.meta.get(this.values[0]) || null].filter(Boolean),
				meta: { changes: 0 },
			};
		}
		if (this.sql.includes("SELECT *") && this.sql.includes("WHERE id = ?")) {
			const row = this.db.rows.get(this.values[0]);
			return { results: row ? [clone(row)] : [], meta: { changes: 0 } };
		}
		if (this.sql.includes("SELECT id") && this.sql.includes("WHERE id = ?")) {
			return this.idLookup((row) => row.id === this.values[0]);
		}
		if (
			this.sql.includes("SELECT id") &&
			this.sql.includes("WHERE row_id = ?")
		) {
			return this.idLookup((row) => row.row_id === this.values[0]);
		}
		if (this.sql.includes("WHERE cookie_hash = ?")) {
			if (this.db.hiddenCookieHashLookups > 0) {
				this.db.hiddenCookieHashLookups--;
				return { results: [], meta: { changes: 0 } };
			}
			const row = Array.from(this.db.rows.values()).find(
				(candidate) => candidate.cookie_hash === this.values[0],
			);
			return { results: row ? [publicClone(row)] : [], meta: { changes: 0 } };
		}
		if (this.sql.includes("COUNT(*) AS total")) {
			const rows = this.applyAdminFilters(Array.from(this.db.rows.values()), 9);
			const attention = new Set([
				"auth_failed",
				"needs_cookie_update",
				"rate_limited",
				"cooling_down",
				"hard_blocked",
				"needs_user_action",
				"missing_cookie",
				"capability_mismatch",
			]);
			const nowMs = this.values[8];
			return {
				results: [
					{
						total: rows.length,
						available: rows.filter(
							(row) => row.enabled === 1 && row.status === "active",
						).length,
						needsAttention: rows.filter((row) => attention.has(row.status))
							.length,
						disabled: rows.filter(
							(row) => row.enabled !== 1 || row.status === "disabled",
						).length,
						refreshable: rows.filter(
							(row) =>
								row.enabled === 1 &&
								["full_session", "psid_psidts"].includes(row.account_category),
						).length,
						cooling: rows.filter(
							(row) =>
								row.cooldown_until_ms != null && row.cooldown_until_ms > nowMs,
						).length,
						psidOnly: rows.filter((row) =>
							["psid_only", "missing_session"].includes(row.account_category),
						).length,
						successCount: rows.reduce(
							(sum, row) => sum + (row.success_count || 0),
							0,
						),
						failureCount: rows.reduce(
							(sum, row) => sum + (row.failure_count || 0),
							0,
						),
					},
				],
				meta: { changes: 0 },
			};
		}
		if (
			this.sql.includes("FROM gemini_accounts") &&
			this.sql.includes("status IN")
		) {
			const statuses = new Set(this.values.slice(0, 4));
			const nowMs = this.values[4];
			const limit = this.values[5];
			const rows = Array.from(this.db.rows.values())
				.filter((row) => row.enabled === 1)
				.filter((row) => statuses.has(row.status))
				.filter(
					(row) =>
						row.cooldown_until_ms == null || row.cooldown_until_ms <= nowMs,
				)
				.sort((a, b) => (a.last_used_at_ms || 0) - (b.last_used_at_ms || 0))
				.slice(0, limit)
				.map(clone);
			return { results: rows, meta: { changes: 0 } };
		}
		if (this.sql.includes("FROM gemini_accounts")) {
			const rows = this.applyAdminFilters(Array.from(this.db.rows.values()), 0)
				.slice(0, this.values.at(-1))
				.map(publicClone);
			return { results: rows, meta: { changes: 0 } };
		}
		throw new Error(`unhandled fake all SQL: ${this.sql}`);
	}

	async run() {
		this.record();
		if (this.sql.includes("INSERT INTO gemini_accounts")) {
			const row = {};
			ACCOUNT_COLUMNS.forEach((name, index) => {
				row[name] = this.values[index];
			});
			this.db.rows.set(row.id, row);
			return changed(1);
		}
		if (this.sql.includes("INSERT INTO gemini_pool_meta")) {
			this.db.meta.set(this.values[0], {
				value: this.values[1],
				updated_at_ms: this.values[2],
			});
			return changed(1);
		}
		if (this.sql.includes("INSERT INTO gemini_account_locks")) {
			const [accountId, lockOwner, expiresAtMs, createdAtMs, nowMs] =
				this.values;
			const existing = this.db.locks.get(accountId);
			if (!existing || existing.expires_at_ms < nowMs) {
				this.db.locks.set(accountId, {
					account_id: accountId,
					lock_owner: lockOwner,
					expires_at_ms: expiresAtMs,
					created_at_ms: createdAtMs,
				});
				return changed(1);
			}
			return changed(0);
		}
		if (this.sql.includes("DELETE FROM gemini_account_locks")) {
			const [accountId, owner] = this.values;
			const existing = this.db.locks.get(accountId);
			if (existing?.lock_owner === owner) {
				this.db.locks.delete(accountId);
				return changed(1);
			}
			return changed(0);
		}
		if (
			this.sql.includes("UPDATE gemini_accounts") &&
			this.sql.includes("cookie_header = ?")
		) {
			const accountId = this.values[16];
			const row = this.db.rows.get(accountId);
			if (!row) return changed(0);
			const duplicate = Array.from(this.db.rows.values()).find(
				(item) => item.id !== accountId && item.cookie_hash === this.values[1],
			);
			if (duplicate)
				throw new Error(
					"UNIQUE constraint failed: gemini_accounts.cookie_hash",
				);
			[
				"cookie_header",
				"cookie_hash",
				"sapisid",
				"session_token",
				"session_token_hash",
				"session_id",
				"language",
				"push_id",
				"secure_1psid_hash",
				"secure_1psidts_hash",
				"account_category",
				"status",
				"state_reason",
				"last_refresh_at_ms",
				"last_refresh_attempt_at_ms",
				"updated_at_ms",
			].forEach((name, index) => {
				row[name] = this.values[index];
			});
			return changed(1);
		}
		if (
			this.sql.includes("UPDATE gemini_accounts") &&
			this.sql.includes("success_count = success_count")
		) {
			const accountId = this.values[14];
			const row = this.db.rows.get(accountId);
			if (!row) return changed(0);
			row.status = this.values[0] || row.status;
			row.state_reason = this.values[1];
			row.cooldown_until_ms = this.values[2];
			if (this.values[3]) row.last_success_at_ms = this.values[4];
			if (this.values[5]) row.last_failure_at_ms = this.values[6];
			row.last_error_code = this.values[7];
			row.last_error_message_redacted = this.values[8];
			row.last_upstream_status = this.values[9];
			row.last_used_at_ms = this.values[10];
			row.success_count += this.values[11];
			row.failure_count += this.values[12];
			row.updated_at_ms = this.values[13];
			return changed(1);
		}
		if (
			this.sql.includes("UPDATE gemini_accounts") &&
			this.sql.includes("SET label = ?")
		) {
			const accountId = this.values[13];
			const row = this.db.rows.get(accountId);
			if (!row) return changed(0);
			[
				"label",
				"enabled",
				"status",
				"state_reason",
				"cooldown_until_ms",
				"account_status_code",
				"account_status_description",
				"user_agent",
				"gemini_origin",
				"source",
				"source_id",
				"source_name",
				"updated_at_ms",
			].forEach((name, index) => {
				row[name] = this.values[index];
			});
			return changed(1);
		}
		if (this.sql.includes("DELETE FROM gemini_accounts")) {
			return changed(this.db.rows.delete(this.values[0]) ? 1 : 0);
		}
		throw new Error(`unhandled fake run SQL: ${this.sql}`);
	}

	idLookup(match) {
		const row = Array.from(this.db.rows.values()).find(match);
		return { results: row ? [{ id: row.id }] : [], meta: { changes: 0 } };
	}

	record() {
		this.db.statements.push({ sql: compactSql(this.sql), values: this.values });
	}

	applyAdminFilters(inputRows, offset) {
		let index = offset;
		const whereSql = this.sql.includes("WHERE")
			? this.sql.split("WHERE").slice(1).join("WHERE")
			: "";
		let rows = inputRows.sort((a, b) => a.id.localeCompare(b.id));
		if (whereSql.includes("id > ?")) {
			const cursor = this.values[index];
			index++;
			rows = rows.filter((row) => row.id > cursor);
		}
		if (whereSql.includes("status = ?")) {
			const status = this.values[index];
			index++;
			rows = rows.filter((row) => row.status === status);
		}
		if (whereSql.includes("enabled = ?")) {
			const enabled = this.values[index];
			index++;
			rows = rows.filter((row) => row.enabled === enabled);
		}
		if (whereSql.includes("account_category = ?")) {
			const category = this.values[index];
			index++;
			rows = rows.filter((row) => row.account_category === category);
		}
		if (
			whereSql.includes(
				"cooldown_until_ms IS NOT NULL AND cooldown_until_ms > ?",
			)
		) {
			const nowMs = this.values[index];
			index++;
			rows = rows.filter(
				(row) => row.cooldown_until_ms != null && row.cooldown_until_ms > nowMs,
			);
		} else if (
			whereSql.includes("cooldown_until_ms IS NULL OR cooldown_until_ms <= ?")
		) {
			const nowMs = this.values[index];
			index++;
			rows = rows.filter(
				(row) =>
					row.cooldown_until_ms == null || row.cooldown_until_ms <= nowMs,
			);
		}
		if (whereSql.includes("source = ? OR source_id = ? OR source_name = ?")) {
			const source = this.values[index];
			index += 3;
			rows = rows.filter(
				(row) =>
					row.source === source ||
					row.source_id === source ||
					row.source_name === source,
			);
		}
		if (whereSql.includes("LIKE ? ESCAPE")) {
			const query = String(this.values[index] || "")
				.replace(/^%|%$/g, "")
				.toLowerCase();
			rows = rows.filter((row) =>
				[
					row.id,
					row.row_id,
					row.label,
					row.status,
					row.state_reason,
					row.source,
					row.source_id,
					row.source_name,
					row.account_category,
					row.last_error_code,
					row.last_error_message_redacted,
				]
					.join(" ")
					.toLowerCase()
					.includes(query),
			);
		}
		return rows;
	}
}

function changed(count) {
	return { success: true, meta: { changes: count } };
}

function compactSql(sql) {
	return sql.replace(/\s+/g, " ").trim();
}

function clone(value) {
	return { ...value };
}

function publicClone(row) {
	const out = clone(row);
	delete out.cookie_header;
	delete out.sapisid;
	delete out.session_token;
	out.has_cookie = !!row.cookie_header;
	out.has_sapisid = !!row.sapisid;
	out.has_session_token = !!row.session_token;
	out.cookie_preview = row.cookie_header ? "present" : "";
	return out;
}
