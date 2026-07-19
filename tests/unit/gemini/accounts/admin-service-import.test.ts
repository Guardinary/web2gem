// @ts-nocheck
import { describe, test } from "vitest";
import {
	identityHashFromCookie,
	sha256Hex,
} from "../../../../src/gemini/accounts/normalize";
import { assert } from "../../assertions.js";
import { deferred } from "../../_support/deferred.js";
import { baseConfig } from "../../_support/runtime-config.js";
import {
	createService,
	mutationCounts,
} from "./_support/admin-service-fixtures.js";
import {
	accountSqlRow,
	accountSummary,
	createAccountStoreDouble,
} from "./_support/store-fixtures.js";

describe("Gemini account admin service imports", () => {
	test("returns compact import counts and forwards canonical bulk entries", async () => {
		const cookieHeader = "__Secure-1PSID=p; __Secure-1PSIDTS=t";
		const cookieHash = await sha256Hex(cookieHeader);
		const identityHash = await identityHashFromCookie(cookieHeader);
		const store = createAccountStoreDouble({
			createAccountsBulk: {
				check([entries]) {
					assert.equal(entries.length, 1);
					assert.equal(entries[0].cookieHash, cookieHash);
					assert.equal(entries[0].identityHash, identityHash);
					assert.equal(entries[0].input.label, "Alpha");
					assert.equal(entries[0].input.nowMs, 1000);
				},
				result: {
					itemsByCookieHash: new Map([
						[cookieHash, accountSummary("account-a")],
					]),
					createdAccountIds: new Set(["account-a"]),
					changedCredentialCookieHashes: new Set(),
				},
			},
			getAccountForRefresh: {
				args: ["account-a"],
				result: null,
			},
		});
		const result = await createService(store).create({
			provider: "gemini",
			accounts: [
				{
					"__Secure-1PSID": "p",
					"__Secure-1PSIDTS": "t",
					label: "Alpha",
				},
				{
					"__Secure-1PSID": "p",
					"__Secure-1PSIDTS": "t",
					label: "Alpha",
				},
			],
		});

		assert.deepEqual(mutationCounts(result), {
			processed: 2,
			changed: 1,
			unchanged: 1,
			failed: 0,
		});
		assert.equal(Object.hasOwn(result, "items"), false);
		store.assertDrained();
	});

	test("registers a new import probe with Worker waitUntil and skips an unchanged identity", async () => {
		const cookieHeader = "__Secure-1PSID=worker; __Secure-1PSIDTS=t";
		const cookieHash = await sha256Hex(cookieHeader);
		const account = accountSqlRow("worker-account", {
			cookie_header: cookieHeader,
			cookie_hash: cookieHash,
		});
		const pending = [];
		let verifyCalls = 0;
		const store = createAccountStoreDouble({
			createAccountsBulk: [
				{
					result: {
						itemsByCookieHash: new Map([
							[cookieHash, accountSummary("worker-account")],
						]),
						createdAccountIds: new Set(["worker-account"]),
						changedCredentialCookieHashes: new Set(),
					},
				},
				{
					result: {
						itemsByCookieHash: new Map([
							[cookieHash, accountSummary("worker-account")],
						]),
						createdAccountIds: new Set(),
						changedCredentialCookieHashes: new Set(),
					},
				},
			],
			getAccountForRefresh: [
				{ args: ["worker-account"], result: account },
				{ args: ["worker-account"], result: account },
			],
			tryAcquireRefreshLock: { result: true },
			writeRefreshedCookie: { result: { changed: true } },
			writeAccountProbe: {
				check([id, probe, checkedAtMs]) {
					assert.equal(id, "worker-account");
					assert.equal(probe.statusCode, 1000);
					assert.equal(checkedAtMs, 1000);
				},
			},
			writeAccountOutcome: {
				args: ["worker-account", { kind: "success", nowMs: 1000 }],
			},
			releaseRefreshLock: {},
		});
		const service = createService(store, {
			cfg: baseConfig({
				runtime_profile: "worker",
				execution_ctx: {
					waitUntil(promise) {
						pending.push(promise);
					},
				},
			}),
			rotateCookie: async () =>
				new Response(null, {
					status: 200,
					headers: { "set-cookie": "__Secure-1PSIDTS=rotated" },
				}),
			verifyAccount: async () => {
				verifyCalls += 1;
				return {
					ok: true,
					at: "fresh-at",
					probe: {
						statusCode: 1000,
						issue: null,
						models: [],
					},
				};
			},
		});
		const body = {
			provider: "gemini",
			accounts: [{ "__Secure-1PSID": "worker", "__Secure-1PSIDTS": "t" }],
		};

		await service.create(body);
		assert.equal(pending.length, 1);
		await pending[0];
		assert.equal(verifyCalls, 1);
		await service.create(body);
		assert.equal(pending.length, 1);
		assert.equal(verifyCalls, 1);
		store.assertDrained();
	});

	test("awaits Docker import probes with concurrency bounded to four", async () => {
		const firstFourStarted = deferred();
		const allStarted = deferred();
		const releases = new Map(
			Array.from({ length: 6 }, (_, index) => [`docker-${index}`, deferred()]),
		);
		let active = 0;
		let maxActive = 0;
		let started = 0;
		let verifyCalls = 0;
		const refreshRows = Array.from({ length: 12 }, () => ({
			run([id]) {
				return accountSqlRow(id, {
					cookie_header: `__Secure-1PSID=${id}; __Secure-1PSIDTS=t-${id}`,
				});
			},
		}));
		const store = createAccountStoreDouble({
			createAccountsBulk: {
				run([entries]) {
					return {
						itemsByCookieHash: new Map(
							entries.map((entry, index) => [
								entry.cookieHash,
								accountSummary(`docker-${index}`),
							]),
						),
						createdAccountIds: new Set(
							entries.map((_entry, index) => `docker-${index}`),
						),
						changedCredentialCookieHashes: new Set(),
					};
				},
			},
			getAccountForRefresh: refreshRows,
			tryAcquireRefreshLock: Array.from({ length: 6 }, () => ({
				result: true,
			})),
			writeRefreshedCookie: Array.from({ length: 6 }, () => ({
				result: { changed: false },
			})),
			releaseRefreshLock: Array.from({ length: 6 }, () => ({})),
		});
		const service = createService(store, {
			cfg: baseConfig({ runtime_profile: "docker" }),
			rotateCookie: async ({ account }) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				started += 1;
				if (started === 4) firstFourStarted.resolve();
				if (started === 6) allStarted.resolve();
				await releases.get(account.id).promise;
				active -= 1;
				return new Response(null, { status: 200 });
			},
			verifyAccount: async () => {
				verifyCalls += 1;
				return { ok: true, at: "fresh-at" };
			},
		});
		const createPromise = service.create({
			provider: "gemini",
			accounts: Array.from({ length: 6 }, (_, index) => ({
				"__Secure-1PSID": `docker-${index}`,
				"__Secure-1PSIDTS": `t-docker-${index}`,
			})),
		});

		await firstFourStarted.promise;
		assert.equal(active, 4);
		for (let index = 0; index < 4; index++)
			releases.get(`docker-${index}`).resolve();
		await allStarted.promise;
		assert.equal(active, 2);
		for (let index = 4; index < 6; index++)
			releases.get(`docker-${index}`).resolve();
		await createPromise;

		assert.equal(maxActive, 4);
		assert.equal(verifyCalls, 6);
		store.assertDrained();
	});
});
