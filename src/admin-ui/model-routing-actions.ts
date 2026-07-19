import {
	getModelRoutingOverview,
	replaceModelRoutePriority,
	resetModelRoutePriority,
} from "./api";
import { tr } from "./i18n";
import { newerModelRoutingOverview } from "./logic";
import {
	connectionVerified,
	emptyModelRoutingDrafts,
	modelRouting,
	modelRoutingDrafts,
	modelRoutingLoading,
} from "./state";
import {
	type AdminSession,
	currentVerifiedAdminSession,
	isCurrentAdminSession,
	runAdminSessionOperation,
	showToast,
} from "./session";
import type {
	ModelFamily,
	ModelRoutingDraft,
	ModelRoutingOverview,
} from "./types";

export async function loadModelRoutingForSession(
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

function setModelRoutingDraft(
	family: ModelFamily,
	update: Partial<Pick<ModelRoutingDraft, "busy" | "error">>,
): void {
	modelRoutingDrafts.value = {
		...modelRoutingDrafts.value,
		[family]: { ...modelRoutingDrafts.value[family], ...update },
	};
}
