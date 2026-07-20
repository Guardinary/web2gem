import { afterEach, describe, test, vi } from "vitest";
import { AdminApiError } from "../../../src/admin-ui/api";
import { language, tr } from "../../../src/admin-ui/i18n";
import { AdminLocalError } from "../../../src/admin-ui/local-errors";
import {
	clearAdminKey,
	confirmDeletion,
	currentAdminSession,
	currentVerifiedAdminSession,
	resolveConfirmation,
	restoreAdminKey,
	runAdminSessionOperation,
	saveAdminKey,
	showToast,
	updateAdminKey,
} from "../../../src/admin-ui/session";
import {
	accountStats,
	accounts,
	adminKey,
	authExpanded,
	batchBusy,
	confirmationDraft,
	connectionVerified,
	cursorStack,
	editBusy,
	editDraft,
	importBusy,
	KEY_STORAGE,
	KEY_STORAGE_MODE,
	keyStorageMode,
	loading,
	modelRouting,
	modelRoutingDrafts,
	modelRoutingLoading,
	nextCursor,
	pageIndex,
	rowBusy,
	selected,
	toastItems,
} from "../../../src/admin-ui/state";
import { assert } from "../assertions.js";
import {
	createMemoryStorage,
	withAdminWindow,
} from "./_support/environment.js";
import {
	emptyStats,
	requiredValue,
	uiAccount,
	uiModelRouting,
} from "./_support/fixtures.js";
import { resetAdminSessionState } from "./_support/state.js";

describe("admin UI session owner", () => {
	afterEach(() => {
		language.value = "en";
		resetAdminSessionState();
	});

	test("invalidates all protected admin state when the credential changes", () => {
		const overview = uiModelRouting();
		updateAdminKey("old-admin-key");
		connectionVerified.value = true;
		authExpanded.value = false;
		accounts.value = [uiAccount()];
		accountStats.value = emptyStats({ total: 1, available: 1 });
		selected.value = new Set(["account-a"]);
		cursorStack.value = ["", "cursor-2"];
		pageIndex.value = 1;
		nextCursor.value = "cursor-3";
		modelRouting.value = overview;
		modelRoutingDrafts.value = {
			pro: {
				routes: requiredValue(overview.families[0]).routes,
				busy: true,
				error: null,
				dirty: true,
			},
			flash: { routes: [], busy: false, error: null, dirty: false },
			flash_lite: { routes: [], busy: false, error: null, dirty: false },
		};
		loading.value = true;
		modelRoutingLoading.value = true;
		importBusy.value = true;
		editBusy.value = true;
		batchBusy.value = "refresh";
		rowBusy.value = { "account-a": "delete" };
		editDraft.value = { key: "account-a", label: "Alpha" };

		const oldSession = currentAdminSession();
		updateAdminKey("new-admin-key");

		assert.equal(oldSession.signal.aborted, true);
		assert.equal(adminKey.value, "new-admin-key");
		assert.equal(connectionVerified.value, false);
		assert.equal(authExpanded.value, true);
		assert.deepEqual(accounts.value, []);
		assert.equal(accountStats.value, null);
		assert.deepEqual([...selected.value], []);
		assert.deepEqual(cursorStack.value, [""]);
		assert.equal(pageIndex.value, 0);
		assert.equal(nextCursor.value, null);
		assert.equal(modelRouting.value, null);
		assert.deepEqual(modelRoutingDrafts.value, {
			pro: { routes: [], busy: false, error: null, dirty: false },
			flash: { routes: [], busy: false, error: null, dirty: false },
			flash_lite: { routes: [], busy: false, error: null, dirty: false },
		});
		assert.deepEqual(
			[
				loading.value,
				modelRoutingLoading.value,
				importBusy.value,
				editBusy.value,
				batchBusy.value,
			],
			[false, false, false, false, ""],
		);
		assert.deepEqual(rowBusy.value, {});
		assert.equal(editDraft.value, null);
	});

	test("exposes a verified session only for the current non-empty credential", () => {
		updateAdminKey("  admin-secret  ");
		const unverified = currentAdminSession();
		assert.equal(unverified.adminKey, "admin-secret");
		assert.equal(currentVerifiedAdminSession(), null);

		connectionVerified.value = true;
		const verified = currentVerifiedAdminSession();
		assert.equal(verified?.adminKey, "admin-secret");
		assert.equal(verified?.signal.aborted, false);
	});

	test("localizes local failures, preserves server messages, and falls back for transport errors", async () => {
		const messages: string[] = [];
		await withAdminWindow(async () => {
			updateAdminKey("admin-secret");
			const session = currentAdminSession();
			language.value = "zh-CN";
			const failures = [
				new AdminApiError("sanitized server message", 400, "safe_error"),
				new AdminLocalError({
					key: "Cookie value required",
					params: { name: "__Secure-1PSID" },
				}),
				new AdminLocalError({ key: "Batch row credentials required" }),
				new TypeError("browser transport detail"),
				new Error("schema detail"),
			];
			for (const failure of failures) {
				const result = await runAdminSessionOperation(
					session,
					async () => {
						throw failure;
					},
					{
						fallbackMessage: tr("Import failed"),
						onError: (message) => messages.push(message),
					},
				);
				assert.deepEqual(result, { ok: false });
			}
		});
		assert.deepEqual(messages, [
			"sanitized server message",
			"需要填写 __Secure-1PSID",
			"每行必须包含 PSID 和 PSIDTS",
			"导入失败",
			"导入失败",
		]);
	});

	test("restores session credentials before local fallback and invalidates prior sessions", async () => {
		const originalWindow = Object.getOwnPropertyDescriptor(
			globalThis,
			"window",
		);
		const localStorage = createMemoryStorage({
			[KEY_STORAGE]: "local-key",
			[KEY_STORAGE_MODE]: "local",
		});
		const sessionStorage = createMemoryStorage({
			[KEY_STORAGE]: "session-key",
		});

		await withAdminWindow(
			async () => {
				updateAdminKey("old-key");
				connectionVerified.value = true;
				const oldSession = currentAdminSession();

				restoreAdminKey();

				assert.equal(oldSession.signal.aborted, true);
				assert.equal(adminKey.value, "session-key");
				assert.equal(keyStorageMode.value, "local");
				assert.equal(connectionVerified.value, false);

				sessionStorage.removeItem(KEY_STORAGE);
				localStorage.setItem(KEY_STORAGE_MODE, "unsupported");
				updateAdminKey("intermediate-key");
				const sessionBeforeFallback = currentAdminSession();

				restoreAdminKey();

				assert.equal(sessionBeforeFallback.signal.aborted, true);
				assert.equal(adminKey.value, "local-key");
				assert.equal(keyStorageMode.value, "session");
			},
			{ localStorage, sessionStorage },
		);

		assert.deepEqual(
			Object.getOwnPropertyDescriptor(globalThis, "window"),
			originalWindow,
		);
	});

	test("saves trimmed credentials to only the selected storage scope", async () => {
		const localStorage = createMemoryStorage({ [KEY_STORAGE]: "old-local" });
		const sessionStorage = createMemoryStorage({
			[KEY_STORAGE]: "old-session",
		});

		await withAdminWindow(
			async () => {
				updateAdminKey("  local-key  ");
				keyStorageMode.value = "local";
				connectionVerified.value = true;
				const localSession = currentAdminSession();

				saveAdminKey();

				assert.equal(localSession.signal.aborted, true);
				assert.equal(adminKey.value, "local-key");
				assert.equal(localStorage.getItem(KEY_STORAGE), "local-key");
				assert.equal(sessionStorage.getItem(KEY_STORAGE), null);
				assert.equal(localStorage.getItem(KEY_STORAGE_MODE), "local");
				assert.equal(connectionVerified.value, false);
				assert.equal(toastItems.value.at(-1)?.message, "Admin key saved");

				updateAdminKey("  session-key  ");
				keyStorageMode.value = "session";
				connectionVerified.value = true;
				const browserSession = currentAdminSession();

				saveAdminKey();

				assert.equal(browserSession.signal.aborted, true);
				assert.equal(adminKey.value, "session-key");
				assert.equal(localStorage.getItem(KEY_STORAGE), null);
				assert.equal(sessionStorage.getItem(KEY_STORAGE), "session-key");
				assert.equal(localStorage.getItem(KEY_STORAGE_MODE), "session");
				assert.equal(connectionVerified.value, false);
			},
			{ localStorage, sessionStorage },
		);
	});

	test("clears credentials from both storage scopes and invalidates the session", async () => {
		const localStorage = createMemoryStorage({ [KEY_STORAGE]: "local-key" });
		const sessionStorage = createMemoryStorage({
			[KEY_STORAGE]: "session-key",
		});

		await withAdminWindow(
			async () => {
				updateAdminKey("active-key");
				connectionVerified.value = true;
				const activeSession = currentAdminSession();

				clearAdminKey();

				assert.equal(activeSession.signal.aborted, true);
				assert.equal(adminKey.value, "");
				assert.equal(localStorage.getItem(KEY_STORAGE), null);
				assert.equal(sessionStorage.getItem(KEY_STORAGE), null);
				assert.equal(connectionVerified.value, false);
				assert.equal(toastItems.value.at(-1)?.message, "Admin key cleared");
			},
			{ localStorage, sessionStorage },
		);
	});

	test("expires each toast on its own five-second timer and restores real timers", async () => {
		const realSetTimeout = globalThis.setTimeout;
		vi.useFakeTimers();
		try {
			await withAdminWindow(
				async () => {
					showToast("first");
					vi.advanceTimersByTime(2500);
					showToast("second");
					assert.deepEqual(
						toastItems.value.map((toast) => toast.message),
						["first", "second"],
					);

					vi.advanceTimersByTime(2500);
					assert.deepEqual(
						toastItems.value.map((toast) => toast.message),
						["second"],
					);

					vi.advanceTimersByTime(2500);
					assert.deepEqual(toastItems.value, []);
					assert.equal(vi.getTimerCount(), 0);
				},
				{ setTimeout: globalThis.setTimeout },
			);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
		assert.equal(globalThis.setTimeout, realSetTimeout);
	});

	test("settles superseded and explicitly resolved deletion confirmations", async () => {
		const first = confirmDeletion(1, "loaded account(s)");
		assert.deepEqual(confirmationDraft.value, {
			action: "delete",
			count: 1,
			targetLabel: "loaded account(s)",
		});

		const second = confirmDeletion(2, "selected account(s)");
		assert.equal(await first, false);
		assert.deepEqual(confirmationDraft.value, {
			action: "delete",
			count: 2,
			targetLabel: "selected account(s)",
		});

		resolveConfirmation(true);
		assert.equal(await second, true);
		assert.equal(confirmationDraft.value, null);
	});

	test("cancels a pending confirmation when the credential changes", async () => {
		updateAdminKey("old-admin-key");
		const confirmation = confirmDeletion(1, "account Alpha");

		updateAdminKey("new-admin-key");

		assert.equal(await confirmation, false);
		assert.equal(confirmationDraft.value, null);
	});
});
