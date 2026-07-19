import {
	createAccount,
	createAccountsWithLimitFallback,
	getAccountOverview,
	runAccountAction,
	updateAccount,
} from "./api";
import { localActionLabel, tr } from "./i18n";
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
	authExpanded,
	batchBusy,
	connectionVerified,
	cursorStack,
	editBusy,
	editDraft,
	importBatch,
	importBusy,
	importLabel,
	importPsid,
	importPsidts,
	loading,
	nextCursor,
	pageIndex,
	query,
	rowBusy,
	selected,
	stateFilter,
} from "./state";
import { loadModelRoutingForSession } from "./model-routing-actions";
import {
	beginAccountLoad,
	confirmDeletion,
	currentAdminSession,
	currentVerifiedAdminSession,
	invalidateAdminSession,
	isCurrentAccountLoad,
	isCurrentAdminSession,
	runAdminSessionOperation,
	showToast,
} from "./session";
import type { AccountAction, AccountIdentifier, GeminiAccount } from "./types";

export {
	moveModelRoute,
	resetModelRoutePriorityAction,
	saveModelRoutePriority,
} from "./model-routing-actions";

export function selectedIdentifiers(): AccountIdentifier[] {
	const current = selected.value;
	return accounts.value
		.filter((account) => current.has(identifierKey(account)))
		.map(identifier);
}

export async function loadAccounts(
	direction: "current" | "reset" | "next" | "prev" = "current",
	verifyConnection = false,
): Promise<void> {
	if (verifyConnection) invalidateAdminSession();
	const session = currentAdminSession();
	if (!session.adminKey) {
		showToast(tr("Admin key is required"), "error");
		return;
	}
	if (!verifyConnection && !connectionVerified.value) return;
	const page = requestedAccountPage(direction);
	if (!page) return;
	const generation = beginAccountLoad();
	const requestedQuery = query.value.trim();
	const requestedState = stateFilter.value;
	loading.value = true;
	try {
		const result = await runAdminSessionOperation(
			session,
			() =>
				getAccountOverview(session, {
					cursor: page.cursor,
					q: requestedQuery,
					state: requestedState,
				}),
			{
				fallbackMessage: tr("Failed to load accounts"),
				isCurrent: () => isCurrentAccountLoad(session, generation),
				invalidateOnError: verifyConnection,
			},
		);
		if (!result.ok) return;
		const overview = result.value;
		commitAccountPage(page, overview);
		if (verifyConnection) {
			connectionVerified.value = true;
			authExpanded.value = false;
			await loadModelRoutingForSession(session);
		}
		if (!isCurrentAccountLoad(session, generation)) return;
		showToast(tr("Loaded account count", { count: overview.items.length }));
	} finally {
		if (isCurrentAccountLoad(session, generation)) loading.value = false;
	}
}

type RequestedAccountPage = {
	cursor: string;
	cursorStack: string[];
	pageIndex: number;
	resetSelection: boolean;
};

type AccountOverviewResult = Awaited<ReturnType<typeof getAccountOverview>>;

function commitAccountPage(
	page: RequestedAccountPage,
	overview: AccountOverviewResult,
): void {
	cursorStack.value = page.cursorStack;
	pageIndex.value = page.pageIndex;
	accounts.value = overview.items;
	accountStats.value = overview.stats;
	nextCursor.value = overview.nextCursor;
	const currentSelection = page.resetSelection ? [] : [...selected.value];
	selected.value = new Set(
		currentSelection.filter((key) =>
			overview.items.some((account) => identifierKey(account) === key),
		),
	);
}

function requestedAccountPage(
	direction: "current" | "reset" | "next" | "prev",
): RequestedAccountPage | null {
	let nextStack = [...cursorStack.value];
	let nextPageIndex = pageIndex.value;
	if (direction === "reset") {
		nextStack = [""];
		nextPageIndex = 0;
	} else if (direction === "next") {
		if (!nextCursor.value) return null;
		nextPageIndex += 1;
		nextStack[nextPageIndex] = nextCursor.value;
	} else if (direction === "prev") {
		if (nextPageIndex <= 0) return null;
		nextPageIndex -= 1;
	}
	return {
		cursor: nextStack[nextPageIndex] || "",
		cursorStack: nextStack,
		pageIndex: nextPageIndex,
		resetSelection: direction === "reset",
	};
}

export async function submitImport(event: Event): Promise<void> {
	event.preventDefault();
	const session = currentVerifiedAdminSession();
	if (!session) return;
	try {
		importBusy.value = true;
		const operation = await runAdminSessionOperation(
			session,
			async () => {
				const batch = parseBatchImport(importBatch.value);
				return batch.length
					? createAccountsWithLimitFallback(session, { accounts: batch })
					: createAccount(session, {
							label: importLabel.value.trim(),
							psid: validateCookieValue(importPsid.value, "__Secure-1PSID"),
							psidts: validateCookieValue(
								importPsidts.value,
								"__Secure-1PSIDTS",
							),
						});
			},
			{ fallbackMessage: tr("Import failed") },
		);
		if (!operation.ok) return;
		const result = operation.value;
		showToast(
			resultSummary("import", result),
			result.failed ? "error" : undefined,
		);
		resetImport();
		await loadAccounts("reset");
	} finally {
		if (isCurrentAdminSession(session)) importBusy.value = false;
	}
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
	const targetLabel = options.targetLabel || tr("selected account(s)");
	if (action === "delete") {
		const confirmed = await confirmDeletion(identifiers.length, targetLabel);
		if (!confirmed) return;
	}
	const session = currentVerifiedAdminSession();
	if (!session) return;
	const keys = identifiers.map((item) => item.id);
	const rowScoped = options.scope === "row" && keys.length === 1;
	try {
		if (rowScoped)
			rowBusy.value = { ...rowBusy.value, [keys[0] || ""]: action };
		else batchBusy.value = action;
		const operation = await runAdminSessionOperation(
			session,
			() => runAccountAction(session, action, identifiers),
			{
				fallbackMessage: tr("Action failure", {
					action: localActionLabel(action, true),
				}),
			},
		);
		if (!operation.ok) return;
		const result = operation.value;
		showToast(
			resultSummary(action, result),
			result.failed ? "error" : undefined,
		);
		await loadAccounts();
	} finally {
		if (isCurrentAdminSession(session)) {
			if (rowScoped) {
				const next = { ...rowBusy.value };
				delete next[keys[0] || ""];
				rowBusy.value = next;
			} else batchBusy.value = "";
		}
	}
}

export async function submitEdit(event: Event): Promise<void> {
	event.preventDefault();
	const session = currentVerifiedAdminSession();
	if (!session) return;
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
		const operation = await runAdminSessionOperation(
			session,
			() =>
				updateAccount(session, {
					...identifier(account),
					label: draft.label.trim() || null,
				}),
			{ fallbackMessage: tr("Update failed") },
		);
		if (!operation.ok) return;
		const result = operation.value;
		showToast(
			resultSummary("update", result),
			result.failed ? "error" : undefined,
		);
		editDraft.value = null;
		await loadAccounts();
	} finally {
		if (isCurrentAdminSession(session)) editBusy.value = false;
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
