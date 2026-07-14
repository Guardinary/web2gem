import type { JSX } from "preact";
import { tr } from "../i18n";
import { metricSummary } from "../selectors";

export function MetricCards(): JSX.Element {
	const stats = metricSummary.value;
	const cards = [
		{ label: "Total", value: stats.total, tone: "neutral" },
		{ label: "Available", value: stats.available, tone: "success" },
		{ label: "Cooling", value: stats.cooling, tone: "info" },
		{ label: "Needs attention", value: stats.attention, tone: "warning" },
		{ label: "Disabled", value: stats.disabled, tone: "neutral" },
	] as const;
	return (
		<section class="primary-metrics" aria-label={tr("Primary metrics")}>
			{cards.map((card) => (
				<div class={`metric metric-primary tone-${card.tone}`} key={card.label}>
					<div class="label">{tr(card.label)}</div>
					<div class="value">{card.value}</div>
				</div>
			))}
		</section>
	);
}
