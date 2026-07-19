import { describe, test } from "vitest";
import {
	identityHashFromCookie,
	normalizeGeminiCookieHeader,
	sha256Hex,
} from "../../../../src/gemini/accounts/normalize";
import { AccountPoolService } from "../../../../src/gemini/accounts/pool";
import type { GeminiAccountOutcome } from "../../../../src/gemini/accounts/runtime-types";
import type { GeminiAccountProbe } from "../../../../src/gemini/accounts/probe-types";
import type { GeminiAccountLease } from "../../../../src/gemini/accounts/lease-types";
import { isRecord } from "../../../../src/shared/types";
import { assert } from "../../assertions.js";
import { deferred } from "../../_support/deferred.js";
import {
	account,
	accountContext,
	createRuntimeStore,
	rejectUnexpectedCookieRotation,
	required,
	runtimeCall,
	runtimeConfig,
	type RuntimeCall,
} from "./_support/runtime-fixtures.js";

const REFRESH_LOCK_TTL_MS = 2 * 60 * 1000;
const UUID_PATTERN =
	"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function observeSetCookie(
	lease: GeminiAccountLease,
	values: readonly string[],
): void {
	const observer = accountContext(lease.config).observeSetCookie;
	if (!observer) throw new Error("account cookie observer is required");
	observer(values);
}

function isCookieWrite(
	value: unknown,
): value is { cookieHeader: string; refreshedAtMs: number } {
	return (
		isRecord(value) &&
		typeof value.cookieHeader === "string" &&
		typeof value.refreshedAtMs === "number"
	);
}

function lockedRuntimeCalls(
	accountId: string,
	nowMs: number,
	ownerPrefix: string,
	middle: readonly RuntimeCall[],
): RuntimeCall[] {
	let owner = "";
	return [
		runtimeCall(
			"tryAcquireRefreshLock",
			(args: [string, string, number, number]) => {
				assert.equal(args.length, 4);
				assert.equal(args[0], accountId);
				assert.match(
					args[1],
					new RegExp(`^${ownerPrefix}:${accountId}:${UUID_PATTERN}$`, "i"),
				);
				assert.deepEqual(args.slice(2), [nowMs + REFRESH_LOCK_TTL_MS, nowMs]);
				owner = args[1];
			},
			true,
		),
		...middle,
		runtimeCall(
			"releaseRefreshLock",
			(args: [string, string]) => assert.deepEqual(args, [accountId, owner]),
			undefined,
		),
	];
}

function rejectedRuntimeLockCall(
	accountId: string,
	nowMs: number,
	ownerPrefix: string,
): RuntimeCall {
	return runtimeCall(
		"tryAcquireRefreshLock",
		(args: [string, string, number, number]) => {
			assert.equal(args.length, 4);
			assert.equal(args[0], accountId);
			assert.match(
				args[1],
				new RegExp(`^${ownerPrefix}:${accountId}:${UUID_PATTERN}$`, "i"),
			);
			assert.deepEqual(args.slice(2), [nowMs + REFRESH_LOCK_TTL_MS, nowMs]);
		},
		false,
	);
}

function refreshedCookieWrite(cookieHeader: string, nowMs = 120000) {
	return { cookieHeader, refreshedAtMs: nowMs, nowMs };
}

async function withFixedNow<T>(
	nowMs: number,
	run: () => T | PromiseLike<T>,
): Promise<T> {
	const original = Date.now;
	Date.now = () => nowMs;
	try {
		return await run();
	} finally {
		Date.now = original;
	}
}

describe("gemini account runtime", () => {
	test("deduplicates refreshes and updates active and cached lease credentials", async () => {
		const row = account("a");
		const rotatedCookie = "__Secure-1PSID=p-a; __Secure-1PSIDTS=rotated";
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [120000, 100], [row]),
			...lockedRuntimeCalls("a", 120000, "account-refresh", [
				runtimeCall("getAccountForRefresh", ["a"], row),
				runtimeCall(
					"writeRefreshedCookie",
					["a", refreshedCookieWrite(rotatedCookie)],
					{ changed: true },
				),
			]),
		]);
		let rotateCalls = 0;
		const rotationStarted = deferred();
		const releaseRotation = deferred();
		const pool = new AccountPoolService(store, {
			nowMs: () => 120000,
			rotateCookie: async () => {
				rotateCalls++;
				rotationStarted.resolve();
				await releaseRotation.promise;
				return new Response(null, {
					status: 200,
					headers: { "set-cookie": "__Secure-1PSIDTS=rotated" },
				});
			},
			verifyAccount: async () => ({ ok: true, at: "fresh-at" }),
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"refresh lease",
		);
		const firstRefresh = lease.refreshForRetry("auth");
		await rotationStarted.promise;
		const secondRefresh = lease.refreshForRetry("auth");
		releaseRotation.resolve();
		const [first, second] = await Promise.all([firstRefresh, secondRefresh]);
		assert.deepEqual(first, second);
		assert.equal(first.changed, true);
		assert.equal(rotateCalls, 1);
		assert.equal(store.callsFor("writeRefreshedCookie").length, 1);
		assert.match(lease.config.cookie, /__Secure-1PSIDTS=rotated/);
		assert.doesNotMatch(lease.config.cookie, /__Secure-1PSIDTS=t(?:;|$)/);
		const rotatedHash = await sha256Hex(
			normalizeGeminiCookieHeader(rotatedCookie),
		);
		assert.equal(accountContext(lease.config).cookieHash, rotatedHash);
		assert.equal(
			typeof accountContext(lease.config).observeSetCookie,
			"function",
		);
		lease.release();
		const cachedLease = required(
			await pool.acquireLease(runtimeConfig()),
			"cached refresh lease",
		);
		assert.match(cachedLease.config.cookie, /__Secure-1PSIDTS=rotated/);
		assert.equal(accountContext(cachedLease.config).cookieHash, rotatedHash);
		cachedLease.release();
		store.assertExhausted();
	});

	test("keeps the lease unchanged when refreshed credentials duplicate another account", async () => {
		const row = account("a");
		const duplicateCookie = "__Secure-1PSID=p-a; __Secure-1PSIDTS=duplicate";
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [120000, 100], [row]),
			...lockedRuntimeCalls("a", 120000, "account-refresh", [
				runtimeCall("getAccountForRefresh", ["a"], row),
				runtimeCall(
					"writeRefreshedCookie",
					["a", refreshedCookieWrite(duplicateCookie)],
					{ changed: false, reason: "duplicate_cookie" },
				),
			]),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => 120000,
			rotateCookie: async () =>
				new Response(null, {
					status: 200,
					headers: { "set-cookie": "__Secure-1PSIDTS=duplicate" },
				}),
			verifyAccount: async () => ({ ok: true, at: "fresh-at" }),
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"duplicate refresh lease",
		);
		const originalCookie = lease.config.cookie;
		const originalHash = accountContext(lease.config).cookieHash;
		assert.deepEqual(await lease.refreshForRetry("auth"), {
			changed: false,
			reason: "rotation_duplicate",
		});
		assert.equal(lease.config.cookie, originalCookie);
		assert.equal(accountContext(lease.config).cookieHash, originalHash);
		lease.release();
		store.assertExhausted();
	});

	test("records rejected refreshes through the shared classifier", async () => {
		const row = account("a");
		const outcome: GeminiAccountOutcome = {
			kind: "failure",
			issue: "auth",
			recoveryScope: "try_next_account",
			nowMs: 120000,
		};
		const store = createRuntimeStore([
			...lockedRuntimeCalls("a", 120000, "account-refresh", [
				runtimeCall("getAccountForRefresh", ["a"], row),
				runtimeCall("writeAccountOutcome", ["a", outcome], undefined),
			]),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => 120000,
			rotateCookie: async () => new Response(null, { status: 401 }),
		});
		assert.deepEqual(await pool.refreshAccountForAdmin(runtimeConfig(), row), {
			changed: false,
			reason: "rotation_rejected",
		});
		assert.deepEqual(store.callsFor("writeAccountOutcome"), [["a", outcome]]);
		store.assertExhausted();
	});

	test("rejects retry refresh when session verification cannot bootstrap", async () => {
		const row = account("missing-at");
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [120000, 100], [row]),
			...lockedRuntimeCalls("missing-at", 120000, "account-refresh", [
				runtimeCall("getAccountForRefresh", ["missing-at"], row),
			]),
		]);
		const pool = new AccountPoolService(store, {
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
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"missing-at refresh lease",
		);
		const originalCookie = lease.config.cookie;
		assert.deepEqual(await lease.refreshForRetry("auth"), {
			changed: false,
			reason: "missing_page_at_token",
		});
		assert.deepEqual(store.callsFor("writeRefreshedCookie"), []);
		assert.equal(lease.config.cookie, originalCookie);
		lease.release();
		store.assertExhausted();
	});

	test("applies structured admin status after credential rotation", async () => {
		const row = account("restricted");
		const rotatedCookie =
			"__Secure-1PSID=p-restricted; __Secure-1PSIDTS=rotated";
		const probe: GeminiAccountProbe = {
			statusCode: 1060,
			issue: "location",
			models: [],
		};
		const outcome: GeminiAccountOutcome = {
			kind: "failure",
			issue: "location",
			recoveryScope: "none",
			nowMs: 120000,
		};
		const store = createRuntimeStore([
			...lockedRuntimeCalls("restricted", 120000, "account-refresh", [
				runtimeCall("getAccountForRefresh", ["restricted"], row),
				runtimeCall(
					"writeRefreshedCookie",
					["restricted", refreshedCookieWrite(rotatedCookie)],
					{ changed: true },
				),
				runtimeCall(
					"writeAccountProbe",
					["restricted", probe, 120000],
					undefined,
				),
				runtimeCall("writeAccountOutcome", ["restricted", outcome], undefined),
			]),
		]);
		const pool = new AccountPoolService(store, {
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
					probe,
				};
			},
		});
		assert.deepEqual(await pool.refreshAccountForAdmin(runtimeConfig(), row), {
			changed: true,
			reason: "status_restricted",
		});
		assert.equal(store.callsFor("writeRefreshedCookie").length, 1);
		assert.deepEqual(store.callsFor("writeAccountProbe"), [
			["restricted", probe, 120000],
		]);
		assert.deepEqual(store.callsFor("writeAccountOutcome"), [
			["restricted", outcome],
		]);
		store.assertExhausted();
	});

	test("skips session maintenance when disabled or the lease is fresh", async () => {
		const nowMs = 120000;
		const row = account("fresh-session", {
			last_refresh_success_at_ms: nowMs - 500,
		});
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], [row]),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"session lease",
		);

		await withFixedNow(nowMs, async () => {
			await lease.maintainSessionIfStale(0);
			await lease.maintainSessionIfStale(1000);
		});

		lease.release();
		store.assertExhausted();
	});

	test("refreshes one stale session and treats a no-update rotation as fresh", async () => {
		const nowMs = 120000;
		const row = account("stale-session", {
			last_refresh_success_at_ms: nowMs - 5000,
		});
		const normalizedCookie = normalizeGeminiCookieHeader(row.cookie_header);
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], [row]),
			...lockedRuntimeCalls("stale-session", nowMs, "account-refresh", [
				runtimeCall("getAccountForRefresh", ["stale-session"], row),
				runtimeCall(
					"writeRefreshedCookie",
					["stale-session", refreshedCookieWrite(normalizedCookie, nowMs)],
					{ changed: false },
				),
			]),
		]);
		let rotateCalls = 0;
		const pool = new AccountPoolService(store, {
			nowMs: () => nowMs,
			rotateCookie: async () => {
				rotateCalls++;
				return new Response(null, { status: 200 });
			},
			verifyAccount: async ({ level }) => {
				assert.equal(level, "session");
				return { ok: true, at: "fresh-at" };
			},
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"passive lease",
		);

		await withFixedNow(nowMs, async () => {
			await lease.maintainSessionIfStale(1000);
			await lease.maintainSessionIfStale(1000);
		});

		assert.equal(rotateCalls, 1);
		assert.equal(store.callsFor("writeRefreshedCookie").length, 1);
		lease.release();
		store.assertExhausted();
	});

	test("persists observed cookies after filtering transient fields", async () => {
		const row = account("passive");
		row.identity_hash = await identityHashFromCookie(row.cookie_header);
		row.cookie_hash = await sha256Hex(
			normalizeGeminiCookieHeader(row.cookie_header),
		);
		const updatedCookie =
			"__Secure-1PSID=p-passive; __Secure-1PSIDTS=passive-update";
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [120000, 100], [row]),
			...lockedRuntimeCalls("passive", 120000, "account-response-cookie", [
				runtimeCall("getAccountForRefresh", ["passive"], row),
				runtimeCall(
					"writeRefreshedCookie",
					["passive", refreshedCookieWrite(updatedCookie)],
					{ changed: true },
				),
			]),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => 120000,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"passive lease",
		);
		observeSetCookie(lease, [
			"__Secure-1PSIDTS=passive-update; Path=/; Secure",
			"SNlM0e=temporary; Path=/",
			"at=temporary; Path=/",
			"session_token=temporary; Path=/",
		]);
		await lease.flushObservedCookies();
		const write = store.callsFor("writeRefreshedCookie")[0];
		if (!write || typeof write[0] !== "string" || !isCookieWrite(write[1]))
			throw new Error("expected refreshed cookie write");
		const accountId = write[0];
		const update = write[1];
		assert.equal(accountId, "passive");
		assert.match(update.cookieHeader, /PSIDTS=passive-update/);
		assert.doesNotMatch(update.cookieHeader, /SNlM0e=|\bat=|session_token=/);
		assert.equal(update.refreshedAtMs, 120000);
		assert.match(lease.config.cookie, /PSIDTS=passive-update/);
		assert.equal(
			accountContext(lease.config).cookieHash,
			await sha256Hex(normalizeGeminiCookieHeader(updatedCookie)),
		);
		lease.release();
		store.assertExhausted();
	});

	test("skips passive persistence when normalized cookie bytes are unchanged", async () => {
		const row = account("passive-unchanged");
		row.identity_hash = await identityHashFromCookie(row.cookie_header);
		row.cookie_hash = await sha256Hex(
			normalizeGeminiCookieHeader(row.cookie_header),
		);
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [120000, 100], [row]),
			...lockedRuntimeCalls(
				"passive-unchanged",
				120000,
				"account-response-cookie",
				[runtimeCall("getAccountForRefresh", ["passive-unchanged"], row)],
			),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => 120000,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"unchanged passive lease",
		);
		const originalCookie = lease.config.cookie;
		const originalHash = accountContext(lease.config).cookieHash;
		observeSetCookie(lease, [
			"__Secure-1PSIDTS=t-passive-unchanged; Path=/; Secure",
		]);

		await lease.flushObservedCookies();

		assert.deepEqual(store.callsFor("writeRefreshedCookie"), []);
		assert.equal(lease.config.cookie, originalCookie);
		assert.equal(accountContext(lease.config).cookieHash, originalHash);
		lease.release();
		store.assertExhausted();
	});

	test("keeps passive lease and snapshot credentials unchanged after a duplicate write", async () => {
		const row = account("passive-duplicate");
		row.identity_hash = await identityHashFromCookie(row.cookie_header);
		row.cookie_hash = await sha256Hex(
			normalizeGeminiCookieHeader(row.cookie_header),
		);
		const duplicateCookie =
			"__Secure-1PSID=p-passive-duplicate; __Secure-1PSIDTS=duplicate";
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [120000, 100], [row]),
			...lockedRuntimeCalls(
				"passive-duplicate",
				120000,
				"account-response-cookie",
				[
					runtimeCall("getAccountForRefresh", ["passive-duplicate"], row),
					runtimeCall(
						"writeRefreshedCookie",
						["passive-duplicate", refreshedCookieWrite(duplicateCookie)],
						{ changed: false, reason: "duplicate_cookie" },
					),
				],
			),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => 120000,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"duplicate passive lease",
		);
		const originalCookie = lease.config.cookie;
		const originalHash = accountContext(lease.config).cookieHash;
		observeSetCookie(lease, ["__Secure-1PSIDTS=duplicate; Path=/; Secure"]);

		await lease.flushObservedCookies();

		assert.equal(lease.config.cookie, originalCookie);
		assert.equal(accountContext(lease.config).cookieHash, originalHash);
		lease.release();
		const cachedLease = required(
			await pool.acquireLease(runtimeConfig()),
			"cached passive lease",
		);
		assert.equal(cachedLease.config.cookie, originalCookie);
		assert.equal(accountContext(cachedLease.config).cookieHash, originalHash);
		cachedLease.release();
		store.assertExhausted();
	});

	test("ignores observed cookies that change the stable account identity", async () => {
		const row = account("passive-identity");
		row.identity_hash = await identityHashFromCookie(row.cookie_header);
		row.cookie_hash = await sha256Hex(
			normalizeGeminiCookieHeader(row.cookie_header),
		);
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [120000, 100], [row]),
			...lockedRuntimeCalls(
				"passive-identity",
				120000,
				"account-response-cookie",
				[runtimeCall("getAccountForRefresh", ["passive-identity"], row)],
			),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => 120000,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"identity passive lease",
		);
		observeSetCookie(lease, ["__Secure-1PSID=other-identity; Path=/; Secure"]);
		await lease.flushObservedCookies();
		assert.deepEqual(store.callsFor("writeRefreshedCookie"), []);
		lease.release();
		store.assertExhausted();
	});

	test("skips observed cookie persistence when the refresh lock is unavailable", async () => {
		const row = account("passive-locked");
		row.identity_hash = await identityHashFromCookie(row.cookie_header);
		row.cookie_hash = await sha256Hex(
			normalizeGeminiCookieHeader(row.cookie_header),
		);
		const store = createRuntimeStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [120000, 100], [row]),
			rejectedRuntimeLockCall(
				"passive-locked",
				120000,
				"account-response-cookie",
			),
		]);
		const pool = new AccountPoolService(store, {
			nowMs: () => 120000,
			rotateCookie: rejectUnexpectedCookieRotation,
		});
		const lease = required(
			await pool.acquireLease(runtimeConfig()),
			"locked passive lease",
		);
		observeSetCookie(lease, ["__Secure-1PSIDTS=locked-update; Path=/; Secure"]);
		await lease.flushObservedCookies();
		assert.deepEqual(store.callsFor("getAccountForRefresh"), []);
		assert.deepEqual(store.callsFor("writeRefreshedCookie"), []);
		lease.release();
		store.assertExhausted();
	});
});
