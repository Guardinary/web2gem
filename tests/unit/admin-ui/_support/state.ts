import { invalidateAdminSession } from "../../../../src/admin-ui/session";
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
	importBatch,
	importBusy,
	importExpanded,
	importLabel,
	importPsid,
	importPsidts,
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
} from "../../../../src/admin-ui/state";

export function resetAccountViewState() {
	accounts.value = [];
	accountStats.value = null;
	selected.value = new Set();
	query.value = "";
	stateFilter.value = "";
	cursorStack.value = [""];
	pageIndex.value = 0;
	nextCursor.value = null;
	loading.value = false;
	batchBusy.value = "";
	rowBusy.value = {};
}

export function resetImportState() {
	importLabel.value = "";
	importPsid.value = "";
	importPsidts.value = "";
	importBatch.value = "";
	importBusy.value = false;
	importExpanded.value = false;
}

export function resetEditState() {
	editDraft.value = null;
	editBusy.value = false;
}

export function resetModelRoutingState() {
	modelRouting.value = null;
	modelRoutingDrafts.value = emptyModelRoutingDrafts();
	modelRoutingLoading.value = false;
}

export function resetSelectorState() {
	accounts.value = [];
	accountStats.value = null;
	selected.value = new Set();
	query.value = "";
	stateFilter.value = "";
}

export function resetAdminSessionState() {
	adminKey.value = "";
	invalidateAdminSession();
	authExpanded.value = false;
	connectionVerified.value = false;
	confirmationDraft.value = null;
	toastItems.value = [];
	keyStorageMode.value = "session";
}
