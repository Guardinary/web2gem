import {
	AdminApiError,
	type AdminApiSession,
	createAccount,
	createAccountsWithLimitFallback,
	getAccountOverview,
	getModelRoutingOverview,
	replaceModelRoutePriority,
	resetModelRoutePriority,
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
	modelRouting,
	modelRoutingDrafts,
	modelRoutingLoading,
	nextCursor,
	pageIndex,
	query,
	rowBusy,
	selected,
	stateFilter,
	toastItems,
} from "./state";
import { emptyModelRoutingDrafts } from "./state";
import type {
	AccountAction,
	AccountIdentifier,
	GeminiAccount,
	ModelFamily,
	ModelRoutingOverview,
} from "./types";

let toastId = 0;
let confirmationResolver: ((confirmed: boolean) => void) | null = null;
let adminSessionGeneration = 0;
let accountLoadGeneration = 0;
let adminSessionAbortController = new AbortController();

type AdminSession = AdminApiSession & {
	generation: number;
};

type AdminSessionOperationResult<T> = { ok: true; value: T } | { ok: false };

type AdminSessionOperationOptions = {
	fallbackMessage: string;
	isCurrent?: () => boolean;
	invalidateOnError?: boolean;
	onError?: (message: string) => void;
};

function currentAdminSession(): AdminSession {
	return {
		generation: adminSessionGeneration,
		adminKey: adminKey.value.trim(),
		signal: adminSessionAbortController.signal,
	};
}

function isCurrentAdminSession(session: AdminSession): boolean {
	return (
		session.generation === adminSessionGeneration &&
		session.signal === adminSessionAbortController.signal &&
		!session.signal.aborted &&
		session.adminKey === adminKey.value.trim()
	);
}

function currentVerifiedAdminSession(): AdminSession | null {
	const session = currentAdminSession();
	return session.adminKey && connectionVerified.value ? session : null;
}

function isCurrentAccountLoad(
	session: AdminSession,
	generation: number,
): boolean {
	return generation === accountLoadGeneration && isCurrentAdminSession(session);
}

function invalidateAdminSession(): void {
	adminSessionGeneration += 1;
	accountLoadGeneration += 1;
	adminSessionAbortController.abort();
	adminSessionAbortController = new AbortController();
	confirmationResolver?.(false);
	confirmationResolver = null;
	connectionVerified.value = false;
	accounts.value = [];
	accountStats.value = null;
	modelRouting.value = null;
	modelRoutingDrafts.value = emptyModelRoutingDrafts();
	selected.value = new Set();
	cursorStack.value = [""];
	pageIndex.value = 0;
	nextCursor.value = null;
	editDraft.value = null;
	confirmationDraft.value = null;
	loading.value = false;
	modelRoutingLoading.value = false;
	importBusy.value = false;
	editBusy.value = false;
	batchBusy.value = "";
	rowBusy.value = {};
	authExpanded.value = true;
}

async function runAdminSessionOperation<T>(
	session: AdminSession,
	operation: () => Promise<T>,
	options: AdminSessionOperationOptions,
): Promise<AdminSessionOperationResult<T>> {
	const isCurrent = options.isCurrent || (() => isCurrentAdminSession(session));
	try {
		const value = await operation();
		return isCurrent() ? { ok: true, value } : { ok: false };
	} catch (error) {
		if (!isCurrent()) return { ok: false };
		const message =
			error instanceof Error ? error.message : options.fallbackMessage;
		const authenticationFailed =
			error instanceof AdminApiError && error.status === 401;
		if (authenticationFailed || options.invalidateOnError)
			invalidateAdminSession();
		else options.onError?.(message);
		showToast(message, "error");
		return { ok: false };
	}
}

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
	invalidateAdminSession();
}

export function updateAdminKey(value: string): void {
	if (value === adminKey.value) return;
	adminKey.value = value;
	invalidateAdminSession();
}

export function saveAdminKey(): void {
	window.sessionStorage.removeItem(KEY_STORAGE);
	window.localStorage.removeItem(KEY_STORAGE);
	window.localStorage.setItem(KEY_STORAGE_MODE, keyStorageMode.value);
	const storage =
		keyStorageMode.value === "local"
			? window.localStorage
			: window.sessionStorage;
	adminKey.value = adminKey.value.trim();
	storage.setItem(KEY_STORAGE, adminKey.value);
	invalidateAdminSession();
	showToast(tr("Admin key saved"));
}

export function clearAdminKey(): void {
	window.sessionStorage.removeItem(KEY_STORAGE);
	window.localStorage.removeItem(KEY_STORAGE);
	adminKey.value = "";
	invalidateAdminSession();
	showToast(tr("Admin key cleared"));
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
	const generation = ++accountLoadGeneration;
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
		showToast(
			language.value === "zh-CN"
				? `已加载 ${overview.items.length} 个账号`
				: `Loaded ${overview.items.length} accounts`,
		);
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

export function loadModelRouting(): Promise<void> {
	const session = currentVerifiedAdminSession();
	return session ? loadModelRoutingForSession(session) : Promise.resolve();
}

async function loadModelRoutingForSession(
	session: AdminSession,
): Promise<void> {
	if (
		!session.adminKey ||
		!connectionVerified.value ||
		!isCurrentAdminSession(session)
	)
		return;
	modelRoutingLoading.value = true;
	try {
		const result = await runAdminSessionOperation(
			session,
			() => getModelRoutingOverview(session),
			{ fallbackMessage: tr("Failed to load model routing") },
		);
		if (result.ok) applyModelRoutingOverview(result.value);
	} finally {
		if (isCurrentAdminSession(session)) modelRoutingLoading.value = false;
	}
}

export function moveModelRoute(
	family: ModelFamily,
	index: number,
	direction: -1 | 1,
): void {
	const draft = modelRoutingDrafts.value[family];
	const target = index + direction;
	if (draft.busy || target < 0 || target >= draft.routes.length) return;
	const routes = [...draft.routes];
	const current = routes[index];
	const adjacent = routes[target];
	if (!current || !adjacent) return;
	routes[index] = adjacent;
	routes[target] = current;
	modelRoutingDrafts.value = {
		...modelRoutingDrafts.value,
		[family]: { ...draft, routes, dirty: true, error: null },
	};
}

export async function saveModelRoutePriority(
	family: ModelFamily,
): Promise<void> {
	const session = currentVerifiedAdminSession();
	if (!session) return;
	const draft = modelRoutingDrafts.value[family];
	setModelRoutingDraft(family, { busy: true, error: null });
	const routes = draft.routes.map(
		({ providerModelId, capacity, capacityField, modelNumber }) => ({
			providerModelId,
			capacity,
			capacityField,
			modelNumber,
		}),
	);
	const result = await runAdminSessionOperation(
		session,
		() => replaceModelRoutePriority(session, family, routes),
		{
			fallbackMessage: tr("Failed to save model routing"),
			onError: (message) =>
				setModelRoutingDraft(family, { busy: false, error: message }),
		},
	);
	if (!result.ok) return;
	applyModelRoutingOverview(result.value, family);
	showToast(tr("Model routing saved"));
}

export async function resetModelRoutePriorityAction(
	family: ModelFamily,
): Promise<void> {
	const session = currentVerifiedAdminSession();
	if (!session) return;
	setModelRoutingDraft(family, { busy: true, error: null });
	const result = await runAdminSessionOperation(
		session,
		() => resetModelRoutePriority(session, family),
		{
			fallbackMessage: tr("Failed to reset model routing"),
			onError: (message) =>
				setModelRoutingDraft(family, { busy: false, error: message }),
		},
	);
	if (!result.ok) return;
	applyModelRoutingOverview(result.value, family);
	showToast(tr("Model routing reset"));
}

function applyModelRoutingOverview(
	overview: ModelRoutingOverview,
	changedFamily?: ModelFamily,
): void {
	const acceptedOverview = newerModelRoutingOverview(
		modelRouting.value,
		overview,
	);
	modelRouting.value = acceptedOverview;
	const current = modelRoutingDrafts.value;
	const next = emptyModelRoutingDrafts();
	for (const family of acceptedOverview.families) {
		const existing = current[family.family];
		if (family.family !== changedFamily && (existing.dirty || existing.busy)) {
			next[family.family] = existing;
			continue;
		}
		next[family.family] = {
			routes: family.routes,
			busy: false,
			error: null,
			dirty: false,
		};
	}
	modelRoutingDrafts.value = next;
}

function newerModelRoutingOverview(
	current: ModelRoutingOverview | null,
	incoming: ModelRoutingOverview,
): ModelRoutingOverview {
	if (!current) return incoming;
	return compareDecimalVersions(incoming.version, current.version) < 0
		? current
		: incoming;
}

function compareDecimalVersions(left: string, right: string): number {
	const normalizedLeft = normalizeDecimalVersion(left);
	const normalizedRight = normalizeDecimalVersion(right);
	if (normalizedLeft.length !== normalizedRight.length)
		return normalizedLeft.length - normalizedRight.length;
	if (normalizedLeft === normalizedRight) return 0;
	return normalizedLeft < normalizedRight ? -1 : 1;
}

function normalizeDecimalVersion(value: string): string {
	return value.replace(/^0+(?=\d)/, "");
}

function setModelRoutingDraft(
	family: ModelFamily,
	update: Partial<
		Pick<(typeof modelRoutingDrafts.value)[ModelFamily], "busy" | "error">
	>,
): void {
	modelRoutingDrafts.value = {
		...modelRoutingDrafts.value,
		[family]: { ...modelRoutingDrafts.value[family], ...update },
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
			{ fallbackMessage: `${action} failed` },
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
