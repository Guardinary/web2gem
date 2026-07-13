import { computed } from "@preact/signals";
import { isCooling, isRefreshable, safeNumber } from "./logic";
import {
	accountStats,
	accounts,
	categoryFilter,
	cooldownFilter,
	enabledFilter,
	query,
	selected,
	sourceFilter,
	statusFilter,
} from "./state";

const ATTENTION_STATUSES = [
	"auth_failed",
	"needs_cookie_update",
	"rate_limited",
	"cooling_down",
	"hard_blocked",
	"needs_user_action",
	"missing_cookie",
	"capability_mismatch",
] as const;

export const metricSummary = computed(() => {
	const stats = accountStats.value;
	const rows = accounts.value;
	return {
		total: stats?.total ?? rows.length,
		available:
			stats?.available ??
			rows.filter(
				(item) => item.status === "active" && Number(item.enabled) === 1,
			).length,
		needsAttention:
			stats?.needsAttention ??
			rows.filter((item) =>
				(ATTENTION_STATUSES as readonly string[]).includes(item.status),
			).length,
		disabled:
			stats?.disabled ??
			rows.filter(
				(item) => Number(item.enabled) !== 1 || item.status === "disabled",
			).length,
		refreshable: stats?.refreshable ?? rows.filter(isRefreshable).length,
		cooling: stats?.cooling ?? rows.filter(isCooling).length,
		psidOnly:
			stats?.psidOnly ??
			rows.filter(
				(item) =>
					item.account_category === "psid_only" ||
					item.account_category === "missing_session",
			).length,
		successCount:
			stats?.successCount ??
			rows.reduce((sum, item) => sum + safeNumber(item.success_count), 0),
		failureCount:
			stats?.failureCount ??
			rows.reduce((sum, item) => sum + safeNumber(item.failure_count), 0),
	};
});

export const selectedCount = computed(() => selected.value.size);

export const advancedFilterCount = computed(
	() =>
		[
			categoryFilter.value,
			cooldownFilter.value,
			sourceFilter.value.trim(),
		].filter(Boolean).length,
);

export const hasFilters = computed(() =>
	Boolean(
		query.value.trim() ||
			statusFilter.value ||
			enabledFilter.value ||
			advancedFilterCount.value,
	),
);
