import { computed } from "@preact/signals";
import { accountStats, accounts, query, selected, stateFilter } from "./state";

export const metricSummary = computed(() => {
	const stats = accountStats.value;
	const rows = accounts.value;
	return {
		total: stats?.total ?? rows.length,
		available:
			stats?.available ??
			rows.filter((item) => item.state === "available").length,
		cooling:
			stats?.cooling ?? rows.filter((item) => item.state === "cooling").length,
		attention:
			stats?.attention ??
			rows.filter((item) => item.state === "attention").length,
		disabled:
			stats?.disabled ??
			rows.filter((item) => item.state === "disabled").length,
	};
});

export const selectedCount = computed(() => selected.value.size);
export const hasFilters = computed(() =>
	Boolean(query.value.trim() || stateFilter.value),
);
