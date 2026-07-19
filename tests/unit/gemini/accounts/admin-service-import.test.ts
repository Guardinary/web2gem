import { describe, test } from "vitest";
import { isRecord } from "../../../../src/shared/types";
import {
	identityHashFromCookie,
	sha256Hex,
} from "../../../../src/gemini/accounts/normalize";
import { deferred, type Deferred } from "../../_support/deferred.js";
import { baseConfig } from "../../_support/runtime-config.js";
import { assert } from "../../assertions.js";
import {
	createService,
	mutationCounts,
} from "./_support/admin-service-fixtures.js";
import {
	accountSqlRow,
	accountSummary,
	createAccountStoreDouble,
} from "./_support/store-fixtures.js";

function argumentAt(args: readonly unknown[], index: number): unknown {
	const value = args[index];
	if (value === undefined)
		throw new Error(`missing callback argument ${index}`);
	return value;
}

function unknownArray(value: unknown, name: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value;
}

describe("Gemini account admin service imports", () => {
	test("preserves created, changed, and unchanged facts in fallback stores", async () => {
		const store = createAccountStoreDouble({
			importAccountByIdentity: [
				{ result: { item: accountSummary("created"), outcome: "created" } },
				{
					result: {
						item: accountSummary("changed"),
						outcome: "credentials_changed",
					},
				},
				{ result: { item: accountSummary("unchanged"), outcome: "unchanged" } },
			],
			getAccountForRefresh: {
				args: ["created"],
				result: null,
			},
		});
		delete store.createAccountsBulk;
		const result = await createService(store).create({
			provider: "gemini",
			accounts: [
				{ "__Secure-1PSID": "new", "__Secure-1PSIDTS": "t" },
				{ "__Secure-1PSID": "changed", "__Secure-1PSIDTS": "t" },
				{ "__Secure-1PSID": "same", "__Secure-1PSIDTS": "t" },
			],
		});
		assert.deepEqual(mutationCounts(result), {
			processed: 3,
			changed: 2,
			unchanged: 1,
			failed: 0,
		});
		store.assertDrained();
	});

	test("returns compact import counts and forwards canonical bulk entries", async () => {
		const cookieHeader = "__Secure-1PSID=p; __Secure-1PSIDTS=t";
		const cookieHash = await sha256Hex(cookieHeader);
		const identityHash = await identityHashFromCookie(cookieHeader);
		const store = createAccountStoreDouble({
			createAccountsBulk: {
				check(args: readonly unknown[]) {
					const entries = unknownArray(argumentAt(args, 0), "entries");
					assert.equal(entries.length, 1);
					const entry = entries[0];
					if (!isRecord(entry) || !isRecord(entry.input))
						throw new Error("invalid bulk entry fixture");
					assert.equal(entry.cookieHash, cookieHash);
					assert.equal(entry.input.identityHash, identityHash);
					assert.equal(entry.input.label, "Alpha");
					assert.equal(entry.input.nowMs, 1000);
				},
				result: {
					createdAccountIds: new Set(["account-a"]),
					changedCredentialCount: 0,
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
		const pending: Promise<unknown>[] = [];
		let verifyCalls = 0;
		const store = createAccountStoreDouble({
			createAccountsBulk: [
				{
					result: {
						createdAccountIds: new Set(["worker-account"]),
						changedCredentialCount: 0,
					},
				},
				{
					result: {
						createdAccountIds: new Set(),
						changedCredentialCount: 0,
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
				check(args: readonly unknown[]) {
					const id = argumentAt(args, 0);
					const probe = argumentAt(args, 1);
					const checkedAtMs = argumentAt(args, 2);
					assert.equal(id, "worker-account");
					if (!isRecord(probe)) throw new Error("invalid probe fixture");
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
					waitUntil(promise: Promise<unknown>) {
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
		const firstProbe = pending[0];
		if (!firstProbe) throw new Error("missing scheduled import probe");
		await firstProbe;
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
			Array.from({ length: 6 }, (_, index): [string, Deferred<unknown>] => [
				`docker-${index}`,
				deferred<unknown>(),
			]),
		);
		let active = 0;
		let maxActive = 0;
		let started = 0;
		let verifyCalls = 0;
		const refreshRows = Array.from({ length: 12 }, () => ({
			run(args: readonly unknown[]) {
				const id = argumentAt(args, 0);
				if (typeof id !== "string") throw new Error("invalid refresh id");
				return accountSqlRow(id, {
					cookie_header: `__Secure-1PSID=${id}; __Secure-1PSIDTS=t-${id}`,
				});
			},
		}));
		const store = createAccountStoreDouble({
			createAccountsBulk: {
				run(args: readonly unknown[]) {
					const entries = unknownArray(argumentAt(args, 0), "entries");
					return {
						createdAccountIds: new Set(
							entries.map((_entry, index) => `docker-${index}`),
						),
						changedCredentialCount: 0,
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
				const release = releases.get(account.id);
				if (!release) throw new Error(`missing release ${account.id}`);
				await release.promise;
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
		for (let index = 0; index < 4; index++) {
			const release = releases.get(`docker-${index}`);
			if (!release) throw new Error(`missing release docker-${index}`);
			release.resolve();
		}
		await allStarted.promise;
		assert.equal(active, 2);
		for (let index = 4; index < 6; index++) {
			const release = releases.get(`docker-${index}`);
			if (!release) throw new Error(`missing release docker-${index}`);
			release.resolve();
		}
		await createPromise;

		assert.equal(maxActive, 4);
		assert.equal(verifyCalls, 6);
		store.assertDrained();
	});
});
