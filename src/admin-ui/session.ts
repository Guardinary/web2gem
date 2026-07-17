import { AdminApiError, type AdminApiSession } from "./api";
import { tr } from "./i18n";
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
	emptyModelRoutingDrafts,
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
} from "./state";

let toastId = 0;
let confirmationResolver: ((confirmed: boolean) => void) | null = null;
let adminSessionGeneration = 0;
let accountLoadGeneration = 0;
let adminSessionAbortController = new AbortController();

export type AdminSession = AdminApiSession & {
	generation: number;
};

export type AdminSessionOperationResult<T> =
	| { ok: true; value: T }
	| { ok: false };

type AdminSessionOperationOptions = {
	fallbackMessage: string;
	isCurrent?: () => boolean;
	invalidateOnError?: boolean;
	onError?: (message: string) => void;
};

export function currentAdminSession(): AdminSession {
	return {
		generation: adminSessionGeneration,
		adminKey: adminKey.value.trim(),
		signal: adminSessionAbortController.signal,
	};
}

export function isCurrentAdminSession(session: AdminSession): boolean {
	return (
		session.generation === adminSessionGeneration &&
		session.signal === adminSessionAbortController.signal &&
		!session.signal.aborted &&
		session.adminKey === adminKey.value.trim()
	);
}

export function currentVerifiedAdminSession(): AdminSession | null {
	const session = currentAdminSession();
	return session.adminKey && connectionVerified.value ? session : null;
}

export function beginAccountLoad(): number {
	return ++accountLoadGeneration;
}

export function isCurrentAccountLoad(
	session: AdminSession,
	generation: number,
): boolean {
	return generation === accountLoadGeneration && isCurrentAdminSession(session);
}

export function invalidateAdminSession(): void {
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

export async function runAdminSessionOperation<T>(
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

export function resolveConfirmation(confirmed: boolean): void {
	const resolve = confirmationResolver;
	confirmationResolver = null;
	confirmationDraft.value = null;
	resolve?.(confirmed);
}

export function confirmDeletion(
	count: number,
	targetLabel: string,
): Promise<boolean> {
	resolveConfirmation(false);
	confirmationDraft.value = { action: "delete", count, targetLabel };
	return new Promise((resolve) => {
		confirmationResolver = resolve;
	});
}
