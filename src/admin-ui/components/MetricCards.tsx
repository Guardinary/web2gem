import type { JSX } from "preact";
import { tr } from "../i18n";
import { isCooling, isRefreshable, safeNumber } from "../logic";
import { accountStats, accounts, selected } from "../state";

export function MetricCards(): JSX.Element {
	const stats = accountStats.value;
	const total = stats?.total ?? accounts.value.length;
	const active =
		stats?.available ??
		accounts.value.filter(
			(item) => item.status === "active" && Number(item.enabled) === 1,
		).length;
	const attention =
		stats?.needsAttention ??
		accounts.value.filter((item) =>
			[
				"auth_failed",
				"needs_cookie_update",
				"rate_limited",
				"cooling_down",
				"hard_blocked",
				"needs_user_action",
				"missing_cookie",
				"capability_mismatch",
			].includes(item.status),
		).length;
	const disabled =
		stats?.disabled ??
		accounts.value.filter(
			(item) => Number(item.enabled) !== 1 || item.status === "disabled",
		).length;
	const refreshable =
		stats?.refreshable ?? accounts.value.filter(isRefreshable).length;
	const cooling = stats?.cooling ?? accounts.value.filter(isCooling).length;
	const psidOnly =
		stats?.psidOnly ??
		accounts.value.filter(
			(item) =>
				item.account_category === "psid_only" ||
				item.account_category === "missing_session",
		).length;
	const successes =
		stats?.successCount ??
		accounts.value.reduce(
			(sum, item) => sum + safeNumber(item.success_count),
			0,
		);
	const failures =
		stats?.failureCount ??
		accounts.value.reduce(
			(sum, item) => sum + safeNumber(item.failure_count),
			0,
		);
	const primaryCards: Array<{
		label: Parameters<typeof tr>[0];
		value: string | number;
		tone: string;
	}> = [
		{ label: "Total", value: total, tone: "neutral" },
		{ label: "Available", value: active, tone: "success" },
		{ label: "Needs attention", value: attention, tone: "warning" },
		{
			label: "Success / fail",
			value: `${successes} / ${failures}`,
			tone: "info",
		},
	];
	const secondaryCards: Array<{
		label: Parameters<typeof tr>[0];
		value: string | number;
	}> = [
		{ label: "Disabled", value: disabled },
		{ label: "Refreshable", value: refreshable },
		{ label: "Cooling", value: cooling },
		{ label: "PSID only", value: psidOnly },
		{ label: "Selected", value: selected.value.size },
	];
	return (
		<div class="metrics">
			<section class="primary-metrics" aria-label={tr("Primary metrics")}>
				{primaryCards.map((card) => (
					<div
						class={`metric metric-primary tone-${card.tone}`}
						key={card.label}
					>
						<div class="label">{tr(card.label)}</div>
						<div class="value">{card.value}</div>
					</div>
				))}
			</section>
			<section class="secondary-metrics" aria-label={tr("Operational metrics")}>
				{secondaryCards.map((card) => (
					<div class="metric metric-secondary" key={card.label}>
						<div class="label">{tr(card.label)}</div>
						<div class="value">{card.value}</div>
					</div>
				))}
			</section>
		</div>
	);
}
