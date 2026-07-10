import {
	createAccount,
	createAccounts,
	getAccountStats,
	listAccounts,
	runAccountAction,
	updateAccount,
} from "./api";
import {
	identifier,
	identifierKey,
	metadataCsv,
	parseBatchImport,
	resultSummary,
	text,
	validateCookieValue,
} from "./logic";
import {
	accountStats,
	actionBusy,
	adminKey,
	accounts,
	categoryFilter,
	cooldownFilter,
	cursorStack,
	editDraft,
	enabledFilter,
	importBatch,
	importLabel,
	importPsid,
	importPsidts,
	KEY_STORAGE,
	KEY_STORAGE_MODE,
	keyStorageMode,
	lastDiagnostics,
	loading,
	nextCursor,
	pageIndex,
	query,
	selected,
	sourceFilter,
	statusFilter,
	toastItems,
} from "./state";
import type { AccountIdentifier, GeminiAccount } from "./types";

let toastId = 0;

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
	showToast("Admin key saved");
}

export function clearAdminKey(): void {
	window.sessionStorage.removeItem(KEY_STORAGE);
	window.localStorage.removeItem(KEY_STORAGE);
	adminKey.value = "";
	accounts.value = [];
	accountStats.value = null;
	selected.value = new Set();
	showToast("Admin key cleared");
}

export function exportMetadata(): void {
	const rows = accounts.value;
	if (!rows.length) {
		showToast("No accounts to export", "error");
		return;
	}
	const url = URL.createObjectURL(
		new Blob([metadataCsv(rows)], { type: "text/csv;charset=utf-8" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = "gemini-account-metadata.csv";
	link.click();
	URL.revokeObjectURL(url);
	showToast(`Exported ${rows.length} metadata rows`);
}

export async function loadAccounts(
	direction: "current" | "reset" | "next" | "prev" = "current",
): Promise<void> {
	if (!adminKey.value.trim()) {
		showToast("Admin key is required", "error");
		return;
	}
	if (direction === "reset") {
		cursorStack.value = [""];
		pageIndex.value = 0;
		nextCursor.value = null;
		selected.value = new Set();
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
		const options = {
			adminKey: adminKey.value,
			cursor: cursorStack.value[pageIndex.value] || "",
			status: statusFilter.value,
			enabled: enabledFilter.value,
			q: query.value.trim(),
			category: categoryFilter.value,
			cooldown: cooldownFilter.value,
			source: sourceFilter.value.trim(),
		};
		const [page, stats] = await Promise.all([
			listAccounts(options),
			getAccountStats(options),
		]);
		accounts.value = page.items;
		accountStats.value = stats;
		nextCursor.value = page.nextCursor;
		selected.value = new Set(
			[...selected.value].filter((key) =>
				page.items.some((account) => identifierKey(account) === key),
			),
		);
		showToast(`Loaded ${page.items.length} accounts`);
	} catch (error) {
		showToast(
			error instanceof Error ? error.message : "Failed to load accounts",
			"error",
		);
	} finally {
		loading.value = false;
	}
}

export async function submitImport(event: Event): Promise<void> {
	event.preventDefault();
	try {
		actionBusy.value = "import";
		const batch = parseBatchImport(importBatch.value);
		const result =
			batch.length > 1
				? await createAccounts(adminKey.value, { accounts: batch })
				: await createAccount(
						adminKey.value,
						batch[0] || {
							label: importLabel.value.trim(),
							psid: validateCookieValue(importPsid.value, "__Secure-1PSID"),
							psidts: validateCookieValue(
								importPsidts.value,
								"__Secure-1PSIDTS",
							),
						},
					);
		lastDiagnostics.value = result;
		showToast(
			resultSummary("import", result),
			result.failed || result.errors?.length ? "error" : undefined,
		);
		resetImport();
		await loadAccounts("reset");
	} catch (error) {
		showToast(
			error instanceof Error ? error.message : "Import failed",
			"error",
		);
	} finally {
		actionBusy.value = "";
	}
}

export async function runAction(
	action: string,
	identifiers: AccountIdentifier[],
	targetLabel = "selected account(s)",
): Promise<void> {
	if (!identifiers.length) {
		showToast("Select at least one account", "error");
		return;
	}
	if (
		action === "delete" &&
		!window.confirm(`Delete ${identifiers.length} ${targetLabel}?`)
	)
		return;
	try {
		actionBusy.value = action;
		const result = await runAccountAction(adminKey.value, action, identifiers);
		lastDiagnostics.value = result;
		showToast(
			resultSummary(action, result),
			result.failed || result.errors?.length ? "error" : undefined,
		);
		await loadAccounts();
	} catch (error) {
		showToast(
			error instanceof Error ? error.message : `${action} failed`,
			"error",
		);
	} finally {
		actionBusy.value = "";
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
		const result = await updateAccount(adminKey.value, {
			...identifier(account),
			label: draft.label.trim() || null,
			status: draft.status,
			enabled: draft.enabled === "true",
			state_reason: draft.stateReason.trim() || null,
			source: draft.source.trim() || null,
			source_name: draft.sourceName.trim() || null,
		});
		showToast(resultSummary("update", result));
		editDraft.value = null;
		await loadAccounts();
	} catch (error) {
		showToast(
			error instanceof Error ? error.message : "Update failed",
			"error",
		);
	}
}

export function openEdit(account: GeminiAccount): void {
	editDraft.value = {
		key: identifierKey(account),
		label: text(account.label),
		status: account.status,
		enabled: Number(account.enabled) === 1 ? "true" : "false",
		stateReason: text(account.state_reason),
		source: text(account.source),
		sourceName: text(account.source_name),
	};
}

export function resetImport(): void {
	importLabel.value = "";
	importPsid.value = "";
	importPsidts.value = "";
	importBatch.value = "";
}
