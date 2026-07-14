import {
	createAccount,
	createAccountsWithLimitFallback,
	getAccountOverview,
	runAccountAction,
	updateAccount,
} from "./api";
import { language, tr } from "./i18n";
import {
	identifier,
	identifierKey,
	parseBatchImport,
	resultSummary,
	text,
	validateCookieValue,
} from "./logic";
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
	importBatch,
	importBusy,
	importLabel,
	importPsid,
	importPsidts,
	KEY_STORAGE,
	KEY_STORAGE_MODE,
	keyStorageMode,
	loading,
	nextCursor,
	pageIndex,
	query,
	rowBusy,
	selected,
	stateFilter,
	toastItems,
} from "./state";
import type { AccountAction, AccountIdentifier, GeminiAccount } from "./types";

let toastId = 0;
let confirmationResolver: ((confirmed: boolean) => void) | null = null;

export function showToast(message: string, kind?: "error"): void {
	const id = ++toastId;
	const item = kind ? { id, message, kind } : { id, message };
	toastItems.value = [...toastItems.value, item];
	window.setTimeout(() => {
		toastItems.value = toastItems.value.filter((toast) => toast.id !== id);
	}, 5000);
}

export function selectedIdentifiers(): AccountIdentifier[] {
	const current = selected.value;
	return accounts.value
		.filter((account) => current.has(identifierKey(account)))
		.map(identifier);
}

export function restoreAdminKey(): void {
	keyStorageMode.value =
		window.localStorage.getItem(KEY_STORAGE_MODE) === "local"
			? "local"
			: "session";
	adminKey.value =
		window.sessionStorage.getItem(KEY_STORAGE) ||
		window.localStorage.getItem(KEY_STORAGE) ||
		"";
	connectionVerified.value = false;
	authExpanded.value = true;
}

export function saveAdminKey(): void {
	window.sessionStorage.removeItem(KEY_STORAGE);
	window.localStorage.removeItem(KEY_STORAGE);
	window.localStorage.setItem(KEY_STORAGE_MODE, keyStorageMode.value);
	const storage =
		keyStorageMode.value === "local"
			? window.localStorage
			: window.sessionStorage;
	storage.setItem(KEY_STORAGE, adminKey.value.trim());
	connectionVerified.value = false;
	authExpanded.value = true;
	showToast(tr("Admin key saved"));
}

export function clearAdminKey(): void {
	window.sessionStorage.removeItem(KEY_STORAGE);
	window.localStorage.removeItem(KEY_STORAGE);
	adminKey.value = "";
	connectionVerified.value = false;
	accounts.value = [];
	accountStats.value = null;
	selected.value = new Set();
	authExpanded.value = true;
	showToast(tr("Admin key cleared"));
}

export async function loadAccounts(
	direction: "current" | "reset" | "next" | "prev" = "current",
	verifyConnection = false,
): Promise<void> {
	if (!adminKey.value.trim()) {
		if (verifyConnection) {
			connectionVerified.value = false;
			authExpanded.value = true;
		}
		showToast(tr("Admin key is required"), "error");
		return;
	}
	if (direction === "reset") {
		cursorStack.value = [""];
		pageIndex.value = 0;
		nextCursor.value = null;
		selected.value = new Set();
		if (verifyConnection) {
			accounts.value = [];
			accountStats.value = null;
		}
	} else if (direction === "next") {
		if (!nextCursor.value) return;
		const nextStack = [...cursorStack.value];
		nextStack[pageIndex.value + 1] = nextCursor.value;
		cursorStack.value = nextStack;
		pageIndex.value += 1;
	} else if (direction === "prev") {
		if (pageIndex.value <= 0) return;
		pageIndex.value -= 1;
	}
	loading.value = true;
	try {
		const overview = await getAccountOverview({
			adminKey: adminKey.value,
			cursor: cursorStack.value[pageIndex.value] || "",
			q: query.value.trim(),
			state: stateFilter.value,
		});
		accounts.value = overview.items;
		accountStats.value = overview.stats;
		nextCursor.value = overview.nextCursor;
		selected.value = new Set(
			[...selected.value].filter((key) =>
				overview.items.some((account) => identifierKey(account) === key),
			),
		);
		if (verifyConnection) {
			connectionVerified.value = true;
			authExpanded.value = false;
		}
		showToast(
			language.value === "zh-CN"
				? `已加载 ${overview.items.length} 个账号`
				: `Loaded ${overview.items.length} accounts`,
		);
	} catch (error) {
		if (verifyConnection) {
			connectionVerified.value = false;
			authExpanded.value = true;
		}
		showToast(
			error instanceof Error ? error.message : tr("Failed to load accounts"),
			"error",
		);
	} finally {
		loading.value = false;
	}
}

export async function submitImport(event: Event): Promise<void> {
	event.preventDefault();
	try {
		importBusy.value = true;
		const batch = parseBatchImport(importBatch.value);
		const result = batch.length
			? await createAccountsWithLimitFallback(adminKey.value, {
					accounts: batch,
				})
			: await createAccount(adminKey.value, {
					label: importLabel.value.trim(),
					psid: validateCookieValue(importPsid.value, "__Secure-1PSID"),
					psidts: validateCookieValue(importPsidts.value, "__Secure-1PSIDTS"),
				});
		showToast(
			resultSummary("import", result),
			result.failed ? "error" : undefined,
		);
		resetImport();
		await loadAccounts("reset");
	} catch (error) {
		showToast(
			error instanceof Error ? error.message : tr("Import failed"),
			"error",
		);
	} finally {
		importBusy.value = false;
	}
}

export function resolveConfirmation(confirmed: boolean): void {
	const resolve = confirmationResolver;
	confirmationResolver = null;
	confirmationDraft.value = null;
	resolve?.(confirmed);
}

function confirmDeletion(count: number, targetLabel: string): Promise<boolean> {
	resolveConfirmation(false);
	confirmationDraft.value = { action: "delete", count, targetLabel };
	return new Promise((resolve) => {
		confirmationResolver = resolve;
	});
}

type RunActionOptions = { targetLabel?: string; scope?: "batch" | "row" };

export async function runAction(
	action: AccountAction,
	identifiers: AccountIdentifier[],
	options: RunActionOptions = {},
): Promise<void> {
	if (!identifiers.length) {
		showToast(tr("Select at least one account"), "error");
		return;
	}
	const targetLabel = options.targetLabel || "selected account(s)";
	if (action === "delete") {
		const confirmed = await confirmDeletion(identifiers.length, targetLabel);
		if (!confirmed) return;
	}
	const keys = identifiers.map((item) => item.id);
	const rowScoped = options.scope === "row" && keys.length === 1;
	try {
		if (rowScoped)
			rowBusy.value = { ...rowBusy.value, [keys[0] || ""]: action };
		else batchBusy.value = action;
		const result = await runAccountAction(adminKey.value, action, identifiers);
		showToast(
			resultSummary(action, result),
			result.failed ? "error" : undefined,
		);
		await loadAccounts();
	} catch (error) {
		showToast(
			error instanceof Error ? error.message : `${action} failed`,
			"error",
		);
	} finally {
		if (rowScoped) {
			const next = { ...rowBusy.value };
			delete next[keys[0] || ""];
			rowBusy.value = next;
		} else batchBusy.value = "";
	}
}

export async function submitEdit(event: Event): Promise<void> {
	event.preventDefault();
	const draft = editDraft.value;
	if (!draft) return;
	const account = accounts.value.find(
		(item) => identifierKey(item) === draft.key,
	);
	if (!account) {
		editDraft.value = null;
		return;
	}
	try {
		editBusy.value = true;
		const result = await updateAccount(adminKey.value, {
			...identifier(account),
			label: draft.label.trim() || null,
		});
		showToast(
			resultSummary("update", result),
			result.failed ? "error" : undefined,
		);
		editDraft.value = null;
		await loadAccounts();
	} catch (error) {
		showToast(
			error instanceof Error ? error.message : tr("Update failed"),
			"error",
		);
	} finally {
		editBusy.value = false;
	}
}

export function openEdit(account: GeminiAccount): void {
	editDraft.value = { key: identifierKey(account), label: text(account.label) };
}

export function resetImport(): void {
	importLabel.value = "";
	importPsid.value = "";
	importPsidts.value = "";
	importBatch.value = "";
}
