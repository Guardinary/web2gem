import type { JSX } from "preact";
import { tr } from "../i18n";
import { metricSummary, selectedCount } from "../selectors";

export function MetricCards(): JSX.Element {
	const stats = metricSummary.value;
	const primaryCards: Array<{
		label: Parameters<typeof tr>[0];
		value: string | number;
		tone: string;
	}> = [
		{ label: "Total", value: stats.total, tone: "neutral" },
		{ label: "Available", value: stats.available, tone: "success" },
		{ label: "Needs attention", value: stats.needsAttention, tone: "warning" },
		{
			label: "Success / fail",
			value: `${stats.successCount} / ${stats.failureCount}`,
			tone: "info",
		},
	];
	const secondaryCards: Array<{
		label: Parameters<typeof tr>[0];
		value: string | number;
	}> = [
		{ label: "Disabled", value: stats.disabled },
		{ label: "Refreshable", value: stats.refreshable },
		{ label: "Cooling", value: stats.cooling },
		{ label: "PSID only", value: stats.psidOnly },
		{ label: "Selected", value: selectedCount.value },
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
