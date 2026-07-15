import { assert } from "./assertions.js";
import { baseConfig, mod } from "./helpers.js";

export const suiteName = "gemini account runtime";
export const cases = [
	[
		"leases the least-used selectable account and derives runtime auth from its cookie",
		async () => {
			const store = new FakeStore([
				account("later", { last_used_at_ms: 2000 }),
				account("first", {
					cookie_header:
						"__Secure-1PSID=p; __Secure-1PSIDTS=t; SAPISID=sapisid-value",
					last_used_at_ms: 1000,
				}),
			]);
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => 3000,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			const lease = await pool.acquireLease(baseConfig());
			assert.equal(lease.accountId, "first");
			assert.equal(lease.config.sapisid, "sapisid-value");
			assert.match(lease.config.cookie, /__Secure-1PSID=p/);
			assert.equal(lease.config.gemini_account.accountId, "first");
			assert.equal(lease.config.gemini_account.cookieHash, "hash-first");
			assert.equal(
				typeof lease.config.gemini_account.observeSetCookie,
				"function",
			);
			lease.release();
			assert.equal(pool.localInFlight("first"), 0);
		},
	],
	[
		"updates account health with one normalized issue model",
		async () => {
			const store = new FakeStore([account("a")]);
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => 1000,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			const lease = await pool.acquireLease(baseConfig());
			await lease.markFailure({ status: 429 }, 1000);
			assert.deepEqual(store.outcomes.at(-1), {
				kind: "failure",
				issue: "rate_limit",
				cooldownUntilMs: 301000,
				recoveryScope: "try_next_account",
				nowMs: 1000,
			});
			await lease.markFailure(new Error("invalid model"), 2000);
			assert.deepEqual(store.outcomes.at(-1), {
				kind: "failure",
				recoveryScope: "none",
				nowMs: 2000,
			});
			await lease.markSuccess(3000);
			assert.deepEqual(store.outcomes.at(-1), {
				kind: "success",
				nowMs: 3000,
			});
		},
	],
	[
		"excludes request-attempted accounts before load balancing",
		async () => {
			const store = new FakeStore([account("a"), account("b")]);
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => 1000,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			const lease = await pool.acquireLease(baseConfig(), {
				excludeAccountIds: new Set(["a"]),
			});
			assert.equal(lease.accountId, "b");
			lease.release();
		},
	],
	[
		"deduplicates refreshes and updates the active lease config after rotation",
		async () => {
			const store = new FakeStore([account("a")]);
			let rotateCalls = 0;
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => 120000,
				rotateCookie: async () => {
					rotateCalls++;
					await Promise.resolve();
					return new Response(null, {
						status: 200,
						headers: { "set-cookie": "__Secure-1PSIDTS=rotated" },
					});
				},
				verifyAccount: async () => ({ ok: true, at: "fresh-at" }),
			});
			const lease = await pool.acquireLease(baseConfig());
			const [first, second] = await Promise.all([
				lease.refreshForRetry("auth"),
				lease.refreshForRetry("auth"),
			]);
			assert.deepEqual(first, second);
			assert.equal(first.changed, true);
			assert.equal(rotateCalls, 1);
			assert.equal(store.writes.length, 1);
			assert.match(lease.config.cookie, /__Secure-1PSIDTS=rotated/);
			assert.doesNotMatch(lease.config.cookie, /__Secure-1PSIDTS=t(?:;|$)/);
			assert.equal(lease.config.gemini_account.cookieHash, lease.cookieHash);
			assert.equal(
				typeof lease.config.gemini_account.observeSetCookie,
				"function",
			);
		},
	],
	[
		"keeps the lease unchanged when refreshed credentials duplicate another account",
		async () => {
			const store = new FakeStore([account("a")]);
			store.writeResult = { changed: false, reason: "duplicate_cookie" };
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => 120000,
				rotateCookie: async () =>
					new Response(null, {
						status: 200,
						headers: { "set-cookie": "__Secure-1PSIDTS=duplicate" },
					}),
				verifyAccount: async () => ({ ok: true, at: "fresh-at" }),
			});
			const lease = await pool.acquireLease(baseConfig());
			const originalCookie = lease.config.cookie;
			const originalHash = lease.cookieHash;
			assert.deepEqual(await lease.refreshForRetry("auth"), {
				changed: false,
				reason: "rotation_duplicate",
				upstreamStatus: 200,
			});
			assert.equal(lease.config.cookie, originalCookie);
			assert.equal(lease.cookieHash, originalHash);
		},
	],
	[
		"records rejected refreshes through the shared classifier",
		async () => {
			const store = new FakeStore([account("a")]);
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => 120000,
				rotateCookie: async () => new Response(null, { status: 401 }),
			});
			assert.deepEqual(
				await pool.refreshAccountForAdmin(baseConfig(), account("a")),
				{
					changed: false,
					reason: "rotation_rejected",
					upstreamStatus: 401,
				},
			);
			assert.deepEqual(store.outcomes.at(-1), {
				kind: "failure",
				issue: "auth",
				recoveryScope: "try_next_account",
				nowMs: 120000,
			});
		},
	],
	[
		"requires fresh bootstrap and applies structured admin status after rotation",
		async () => {
			const missingStore = new FakeStore([account("missing-at")]);
			const missingPool = new mod.AccountPoolService(missingStore, {
				nowMs: () => 120000,
				rotateCookie: async () =>
					new Response(null, {
						status: 200,
						headers: { "set-cookie": "__Secure-1PSIDTS=rotated" },
					}),
				verifyAccount: async () => ({
					ok: false,
					reason: "missing_page_at_token",
				}),
			});
			const missingLease = await missingPool.acquireLease(baseConfig());
			const originalCookie = missingLease.config.cookie;
			assert.deepEqual(await missingLease.refreshForRetry("auth"), {
				changed: false,
				reason: "missing_page_at_token",
			});
			assert.equal(missingStore.writes.length, 0);
			assert.equal(missingLease.config.cookie, originalCookie);

			const restrictedStore = new FakeStore([account("restricted")]);
			const restrictedPool = new mod.AccountPoolService(restrictedStore, {
				nowMs: () => 120000,
				rotateCookie: async () =>
					new Response(null, {
						status: 200,
						headers: { "set-cookie": "__Secure-1PSIDTS=rotated" },
					}),
				verifyAccount: async ({ level }) => {
					assert.equal(level, "status");
					return {
						ok: true,
						at: "fresh-at",
						probe: {
							statusCode: 1060,
							issue: "location",
							selectable: false,
							models: [],
						},
					};
				},
			});
			assert.deepEqual(
				await restrictedPool.refreshAccountForAdmin(
					baseConfig(),
					account("restricted"),
				),
				{
					changed: true,
					reason: "status_restricted",
					statusCode: 1060,
				},
			);
			assert.equal(restrictedStore.writes.length, 1);
			assert.deepEqual(restrictedStore.outcomes.at(-1), {
				kind: "failure",
				issue: "location",
				recoveryScope: "none",
				nowMs: 120000,
			});
		},
	],
	[
		"prefers fresh known-capable accounts and keeps unknown fallback configurable",
		async () => {
			const nowMs = 100000;
			const rows = [
				account("incapable", { status_checked_at_ms: nowMs }),
				account("unknown", { status_checked_at_ms: null }),
				account("capable", { status_checked_at_ms: nowMs }),
			];
			const store = new FakeStore(rows);
			store.listAccountCapabilities = async () => [
				{
					account_id: "capable",
					model_id: "model-pro",
					display_name: "Pro",
					description: "Pro route",
					available: 1,
					capacity: 4,
					capacity_field: 12,
					model_number: 1,
					discovery_order: 0,
					checked_at_ms: nowMs,
				},
			];
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => nowMs,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			const route = {
				providerModelId: "model-pro",
				capacity: 4,
				capacityField: 12,
				modelNumber: 1,
			};
			const capable = await pool.acquireLease(baseConfig(), {
				routeRequirement: {
					candidates: [route],
					fallbackRoute: mod.basicRouteForFamily("pro"),
				},
				capabilityMode: "prefer",
				capabilityFreshAfterMs: nowMs - 1000,
			});
			assert.equal(capable.accountId, "capable");
			assert.deepEqual(capable.modelCapability, {
				modelId: "model-pro",
				displayName: "Pro",
				description: "Pro route",
				available: true,
				capacity: 4,
				capacityField: 12,
				modelNumber: 1,
				discoveryOrder: 0,
				checkedAtMs: nowMs,
			});
			assert.deepEqual(capable.selectedRoute, route);
			capable.release();

			const fallbackStore = new FakeStore([
				account("known-no", { status_checked_at_ms: nowMs }),
				account("unknown-only", { status_checked_at_ms: null }),
			]);
			fallbackStore.listAccountCapabilities = async () => [
				capabilityRow("known-no", "different-model", 1, 12, 1, 0, nowMs),
			];
			const fallbackPool = new mod.AccountPoolService(fallbackStore, {
				nowMs: () => nowMs,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			const preferred = await fallbackPool.acquireLease(baseConfig(), {
				routeRequirement: {
					candidates: [route],
					fallbackRoute: mod.basicRouteForFamily("pro"),
				},
				capabilityMode: "prefer",
				capabilityFreshAfterMs: nowMs - 1000,
			});
			assert.equal(preferred.accountId, "unknown-only");
			assert.equal(preferred.modelCapability, null);
			assert.deepEqual(preferred.selectedRoute, mod.basicRouteForFamily("pro"));
			preferred.release();
			assert.equal(
				await fallbackPool.acquireLease(baseConfig(), {
					routeRequirement: {
						candidates: [route],
						fallbackRoute: mod.basicRouteForFamily("pro"),
					},
					capabilityMode: "strict",
					capabilityFreshAfterMs: nowMs - 1000,
				}),
				null,
			);
		},
	],
	[
		"uses Basic for stale known-family fallback and forbids dynamic fallback",
		async () => {
			const nowMs = 100000;
			const staleRoute = {
				providerModelId: "e6fa609c3fa255c0",
				capacity: 4,
				capacityField: 12,
				modelNumber: 3,
			};
			const store = new FakeStore([
				account("stale", { status_checked_at_ms: nowMs }),
			]);
			store.listAccountCapabilities = async () => [
				capabilityRow(
					"stale",
					staleRoute.providerModelId,
					staleRoute.capacity,
					staleRoute.capacityField,
					staleRoute.modelNumber,
					0,
					nowMs - 5000,
				),
			];
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => nowMs,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			const knownLease = await pool.acquireLease(baseConfig(), {
				routeRequirement: {
					candidates: [staleRoute],
					fallbackRoute: mod.basicRouteForFamily("pro"),
				},
				capabilityMode: "prefer",
				capabilityFreshAfterMs: nowMs - 1000,
			});
			assert.equal(knownLease.accountId, "stale");
			assert.equal(knownLease.modelCapability, null);
			assert.deepEqual(
				knownLease.selectedRoute,
				mod.basicRouteForFamily("pro"),
			);
			knownLease.release();

			for (const capabilityMode of ["off", "prefer", "strict"]) {
				assert.equal(
					await pool.acquireLease(baseConfig(), {
						routeRequirement: {
							candidates: [staleRoute],
							fallbackRoute: null,
						},
						capabilityMode,
						capabilityFreshAfterMs: nowMs - 1000,
					}),
					null,
				);
			}
		},
	],
	[
		"binds off-mode failover to the selected account's own exact route",
		async () => {
			const nowMs = 100000;
			const plusRoute = {
				providerModelId: "e6fa609c3fa255c0",
				capacity: 4,
				capacityField: 12,
				modelNumber: 3,
			};
			const basicRoute = mod.basicRouteForFamily("pro");
			const store = new FakeStore([account("a-plus"), account("b-basic")]);
			store.listAccountCapabilities = async () => [
				capabilityRow("a-plus", plusRoute.providerModelId, 4, 12, 3, 0, nowMs),
				capabilityRow(
					"b-basic",
					basicRoute.providerModelId,
					basicRoute.capacity,
					basicRoute.capacityField,
					basicRoute.modelNumber,
					0,
					nowMs,
				),
			];
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => nowMs,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			const options = {
				routeRequirement: {
					candidates: [plusRoute, basicRoute],
					fallbackRoute: basicRoute,
				},
				capabilityMode: "off",
				capabilityFreshAfterMs: nowMs - 1000,
			};
			const first = await pool.acquireLease(baseConfig(), options);
			assert.equal(first.accountId, "a-plus");
			assert.deepEqual(first.selectedRoute, plusRoute);
			first.release();

			const second = await pool.acquireLease(baseConfig(), {
				...options,
				excludeAccountIds: new Set(["a-plus"]),
			});
			assert.equal(second.accountId, "b-basic");
			assert.deepEqual(second.selectedRoute, basicRoute);
			assert.equal(second.modelCapability.modelId, basicRoute.providerModelId);
			second.release();
		},
	],
	[
		"loads selected-account capabilities independently from the global catalog",
		async () => {
			const nowMs = 100000;
			const route = mod.basicRouteForFamily("pro");
			const store = new FakeStore([account("selected")]);
			let selectedIds = null;
			let globalLoads = 0;
			store.listAccountCapabilities = async (accountIds) => {
				selectedIds = accountIds;
				return [
					capabilityRow(
						"selected",
						route.providerModelId,
						route.capacity,
						route.capacityField,
						route.modelNumber,
						0,
						nowMs,
					),
				];
			};
			store.listAllAccountCapabilities = async () => {
				globalLoads += 1;
				return [
					capabilityRow("not-selected", "future-model", 3, 13, 7, 0, nowMs),
				];
			};
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => nowMs,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			const lease = await pool.acquireLease(baseConfig(), {
				routeRequirement: { candidates: [route], fallbackRoute: route },
				capabilityMode: "strict",
				capabilityFreshAfterMs: nowMs - 1000,
			});
			assert.deepEqual(selectedIds, ["selected"]);
			assert.equal(globalLoads, 1);
			assert.equal(lease.accountId, "selected");
			assert.deepEqual(lease.selectedRoute, route);
			lease.release();
		},
	],
	[
		"builds one catalog and honors saved exact-route priority",
		async () => {
			const nowMs = 100000;
			const rows = [
				account("first", { status_checked_at_ms: nowMs }),
				account("second", { status_checked_at_ms: nowMs }),
			];
			const store = new FakeStore(rows);
			store.listAccountCapabilities = async () => [
				capabilityRow("first", "e6fa609c3fa255c0", 4, 12, 3, 0, nowMs, {
					display_name: "First Pro",
				}),
				capabilityRow("first", "future-model", 3, 13, 7, 1, nowMs),
				capabilityRow("first", "invalid model id", 3, 13, 7, 2, nowMs),
				capabilityRow("first", "cf41b0e0dd7d53e5", 1, 12, 6, 2, nowMs, {
					available: 0,
				}),
				capabilityRow("second", "9d8ca3786ebdfbea", 1, 12, 3, 0, nowMs, {
					display_name: "Second Pro",
				}),
			];
			store.listModelRoutePriorities = async () => [
				{
					family: "pro",
					provider_model_id: "invalid model id",
					capacity: 9,
					capacity_field: 99,
					model_number: 0,
					priority: 0,
					updated_at_ms: nowMs,
				},
				{
					family: "pro",
					provider_model_id: "9d8ca3786ebdfbea",
					capacity: 1,
					capacity_field: 12,
					model_number: 3,
					priority: 1,
					updated_at_ms: nowMs,
				},
				{
					family: "pro",
					provider_model_id: "e6fa609c3fa255c0",
					capacity: 2,
					capacity_field: 12,
					model_number: 3,
					priority: 2,
					updated_at_ms: nowMs,
				},
			];
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => nowMs,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			const catalog = await pool.modelCatalog(nowMs - 1000);
			assert.deepEqual(
				catalog.entries.map((entry) => entry.id),
				[
					"gemini-3.5-flash",
					"gemini-3.5-flash-extended",
					"gemini-3.1-pro",
					"gemini-3.1-pro-extended",
					"future-model",
					"future-model-extended",
				],
			);
			assert.equal(
				(
					await pool.resolveModel(
						"future-model-extended",
						"gemini-3.5-flash",
						nowMs - 1000,
					)
				).dynamicProviderId,
				"future-model",
			);
			const resolvedPro = mod.resolveModel(
				"gemini-3.1-pro",
				"gemini-3.5-flash",
			);
			const candidates = await pool.routeCandidatesForModel(
				resolvedPro,
				nowMs - 1000,
			);
			assert.deepEqual(
				candidates.map((route) => route.providerModelId),
				["9d8ca3786ebdfbea", "e6fa609c3fa255c0"],
			);
			const overview = await pool.modelRoutingOverview(nowMs - 1000);
			assert.equal(overview.version, "1");
			assert.deepEqual(
				overview.families.map((family) => family.family),
				["pro", "flash", "flash_lite"],
			);
			const proOverview = overview.families[0];
			assert.deepEqual(proOverview.publicNames, [
				"gemini-3.1-pro",
				"gemini-3.1-pro-extended",
			]);
			assert.equal(proOverview.configured, true);
			assert.deepEqual(
				proOverview.routes.map((route) => ({
					providerModelId: route.providerModelId,
					capacity: route.capacity,
					label: route.label,
					available: route.available,
					configured: route.configured,
					accountCount: route.accountCount,
				})),
				[
					{
						providerModelId: "9d8ca3786ebdfbea",
						capacity: 1,
						label: "Basic",
						available: true,
						configured: true,
						accountCount: 1,
					},
					{
						providerModelId: "e6fa609c3fa255c0",
						capacity: 2,
						label: "Advanced",
						available: false,
						configured: true,
						accountCount: 0,
					},
					{
						providerModelId: "e6fa609c3fa255c0",
						capacity: 4,
						label: "Plus",
						available: true,
						configured: false,
						accountCount: 1,
					},
				],
			);
			const lease = await pool.acquireLease(baseConfig(), {
				routeRequirement: {
					candidates,
					fallbackRoute: mod.basicRouteForFamily("pro"),
				},
				capabilityMode: "prefer",
				capabilityFreshAfterMs: nowMs - 1000,
			});
			assert.equal(lease.accountId, "second");
			assert.equal(lease.selectedRoute.providerModelId, "9d8ca3786ebdfbea");
			lease.release();

			const rediscoveredStore = new FakeStore(rows);
			rediscoveredStore.listAccountCapabilities = async () => [
				capabilityRow("second", "9d8ca3786ebdfbea", 1, 12, 3, 0, nowMs),
				capabilityRow("first", "e6fa609c3fa255c0", 2, 12, 3, 0, nowMs),
				capabilityRow("second", "e6fa609c3fa255c0", 4, 12, 3, 1, nowMs),
			];
			rediscoveredStore.listModelRoutePriorities =
				store.listModelRoutePriorities;
			const rediscoveredPool = new mod.AccountPoolService(rediscoveredStore, {
				nowMs: () => nowMs,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			assert.deepEqual(
				(
					await rediscoveredPool.routeCandidatesForModel(
						resolvedPro,
						nowMs - 1000,
					)
				).map((route) => [route.providerModelId, route.capacity]),
				[
					["9d8ca3786ebdfbea", 1],
					["e6fa609c3fa255c0", 2],
					["e6fa609c3fa255c0", 4],
				],
			);

			const staleStore = new FakeStore([
				account("disabled", { enabled: 0, status_checked_at_ms: nowMs - 5000 }),
			]);
			staleStore.listAllAccountCapabilities = async () => [
				capabilityRow("disabled", "persisted-model", 2, 12, 1, 0, nowMs - 5000),
			];
			const stalePool = new mod.AccountPoolService(staleStore, {
				nowMs: () => nowMs,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			assert.deepEqual(
				(await stalePool.modelCatalog(nowMs - 1000)).entries.map(
					(entry) => entry.id,
				),
				[
					"gemini-3.5-flash",
					"gemini-3.5-flash-extended",
					"persisted-model",
					"persisted-model-extended",
				],
			);
		},
	],
	[
		"keeps exact dynamic provider IDs ahead of synthesized extended aliases",
		async () => {
			const nowMs = 100000;
			const store = new FakeStore([account("dynamic")]);
			store.listAccountCapabilities = async () => [
				capabilityRow("dynamic", "future-model", 3, 13, 7, 0, nowMs),
				capabilityRow("dynamic", "future-model-extended", 3, 13, 8, 1, nowMs),
			];
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => nowMs,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});

			const catalog = await pool.modelCatalog(nowMs - 1000);
			assert.deepEqual(
				catalog.entries.map((entry) => entry.id),
				[
					"gemini-3.5-flash",
					"gemini-3.5-flash-extended",
					"future-model",
					"future-model-extended",
					"future-model-extended-extended",
				],
			);
			assert.deepEqual(
				await pool.resolveModel(
					"future-model-extended",
					"gemini-3.5-flash",
					nowMs - 1000,
				),
				{
					name: "future-model-extended",
					family: null,
					extended: false,
					dynamicProviderId: "future-model-extended",
				},
			);
			assert.deepEqual(
				await pool.resolveModel(
					"future-model-extended-extended",
					"gemini-3.5-flash",
					nowMs - 1000,
				),
				{
					name: "future-model-extended-extended",
					family: null,
					extended: true,
					dynamicProviderId: "future-model-extended",
				},
			);
		},
	],
	[
		"reserves known public names for their static model families",
		async () => {
			const nowMs = 100000;
			const store = new FakeStore([account("collision"), account("known-pro")]);
			store.listAccountCapabilities = async () => [
				capabilityRow("collision", "gemini-3.1-pro", 3, 13, 7, 0, nowMs),
				capabilityRow("known-pro", "9d8ca3786ebdfbea", 1, 12, 3, 0, nowMs),
			];
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => nowMs,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});

			const catalog = await pool.modelCatalog(nowMs - 1000);
			const proEntry = catalog.entries.find(
				(entry) => entry.id === "gemini-3.1-pro",
			);
			assert.deepEqual(proEntry, {
				id: "gemini-3.1-pro",
				family: "pro",
				providerModelId: "9d8ca3786ebdfbea",
				displayName: "9d8ca3786ebdfbea",
				description: "9d8ca3786ebdfbea description",
				extended: false,
			});

			const resolved = await pool.resolveModel(
				"gemini-3.1-pro",
				"gemini-3.5-flash",
				nowMs - 1000,
			);
			const candidates = await pool.routeCandidatesForModel(
				resolved,
				nowMs - 1000,
			);
			assert.deepEqual(
				candidates.map((route) => route.providerModelId),
				["9d8ca3786ebdfbea"],
			);
			const lease = await pool.acquireLease(baseConfig(), {
				routeRequirement: {
					candidates,
					fallbackRoute: mod.basicRouteForFamily("pro"),
				},
				capabilityMode: "prefer",
				capabilityFreshAfterMs: nowMs - 1000,
			});
			assert.equal(lease.accountId, "known-pro");
			lease.release();
		},
	],
	[
		"writes observed response cookies only after filtering and identity checks",
		async () => {
			const row = account("passive");
			row.identity_hash = await mod.identityHashFromCookie(row.cookie_header);
			row.cookie_hash = await mod.sha256Hex(
				mod.normalizeGeminiCookieHeader(row.cookie_header),
			);
			const store = new FakeStore([row]);
			const pool = new mod.AccountPoolService(store, {
				nowMs: () => 120000,
				rotateCookie: async () => new Response(null, { status: 200 }),
			});
			const lease = await pool.acquireLease(baseConfig());
			lease.config.gemini_account.observeSetCookie([
				"__Secure-1PSIDTS=passive-update; Path=/; Secure",
				"at=temporary; Path=/",
				"session_token=temporary; Path=/",
			]);
			await lease.flushObservedCookies();
			assert.equal(store.writes.length, 1);
			assert.match(lease.config.cookie, /PSIDTS=passive-update/);
			assert.doesNotMatch(lease.config.cookie, /\bat=|session_token=/);
			assert.equal(lease.config.gemini_account.cookieHash, lease.cookieHash);

			lease.config.gemini_account.observeSetCookie([
				"__Secure-1PSID=other-identity; Path=/; Secure",
			]);
			await lease.flushObservedCookies();
			assert.equal(store.writes.length, 1);

			store.lockAvailable = false;
			lease.config.gemini_account.observeSetCookie([
				"__Secure-1PSIDTS=locked-update; Path=/; Secure",
			]);
			await lease.flushObservedCookies();
			assert.equal(store.writes.length, 1);
		},
	],
	[
		"keeps page and push token cache scopes account-specific without D1 page state",
		() => {
			const first = mod.geminiAccountCacheScope({
				...baseConfig(),
				gemini_account: { accountId: "a", cookieHash: "ha" },
			});
			const second = mod.geminiAccountCacheScope({
				...baseConfig(),
				gemini_account: { accountId: "b", cookieHash: "hb" },
			});
			assert.match(first, /account:a.*cookie:ha/);
			assert.match(second, /account:b.*cookie:hb/);
			assert.equal(first === second, false);
		},
	],
];

function account(id, overrides = {}) {
	return {
		id,
		label: null,
		enabled: 1,
		cookie_header: `__Secure-1PSID=p-${id}; __Secure-1PSIDTS=t-${id}`,
		cookie_hash: `hash-${id}`,
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

function capabilityRow(
	accountId,
	modelId,
	capacity,
	capacityField,
	modelNumber,
	discoveryOrder,
	checkedAtMs,
	overrides = {},
) {
	return {
		account_id: accountId,
		model_id: modelId,
		display_name: modelId,
		description: `${modelId} description`,
		available: 1,
		capacity,
		capacity_field: capacityField,
		model_number: modelNumber,
		discovery_order: discoveryOrder,
		checked_at_ms: checkedAtMs,
		...overrides,
	};
}

class FakeStore {
	constructor(rows) {
		this.rows = new Map(rows.map((row) => [row.id, row]));
		this.outcomes = [];
		this.writes = [];
		this.writeResult = { changed: true };
		this.lockAvailable = true;
	}
	async getPoolVersion() {
		return "1";
	}
	async listSelectableAccounts() {
		return [...this.rows.values()]
			.filter((row) => row.enabled === 1)
			.sort(
				(a, b) =>
					(a.last_used_at_ms || 0) - (b.last_used_at_ms || 0) ||
					a.id.localeCompare(b.id),
			)
			.map((row) => ({
				id: row.id,
				enabled: row.enabled,
				cookie_header: row.cookie_header,
				cookie_hash: row.cookie_hash,
				issue: row.issue,
				cooldown_until_ms: row.cooldown_until_ms,
				last_used_at_ms: row.last_used_at_ms,
				status_checked_at_ms: row.status_checked_at_ms,
				last_refresh_success_at_ms: row.last_refresh_success_at_ms,
			}));
	}
	async getAccountForRefresh(id) {
		return this.rows.get(id) || null;
	}
	async tryAcquireRefreshLock() {
		return this.lockAvailable;
	}
	async releaseRefreshLock() {}
	async writeRefreshedCookie(id, update) {
		this.writes.push({ id, update });
		if (this.writeResult.changed) {
			const row = this.rows.get(id);
			row.cookie_header = update.cookieHeader;
			row.cookie_hash = await mod.sha256Hex(
				mod.normalizeGeminiCookieHeader(update.cookieHeader),
			);
			row.last_refresh_at_ms = update.refreshedAtMs;
		}
		return this.writeResult;
	}
	async writeAccountOutcome(id, outcome) {
		this.outcomes.push(outcome);
		const row = this.rows.get(id);
		row.last_used_at_ms = outcome.nowMs;
		if (outcome.kind === "success") {
			row.issue = null;
			row.cooldown_until_ms = null;
		} else if (outcome.issue) {
			row.issue = outcome.issue;
			row.cooldown_until_ms = outcome.cooldownUntilMs ?? null;
		}
	}
}
