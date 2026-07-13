import type { JSX } from "preact";
import { MetricCards } from "../components";
import { Icon } from "../icons";
import { tr } from "../i18n";
import { importExpanded } from "../state";

export function OverviewSection(): JSX.Element {
	return (
		<section class="section-block" aria-labelledby="overview-title">
			<div class="section-heading">
				<div>
					<span class="eyebrow">{tr("Overview")}</span>
					<h2 id="overview-title">{tr("Gemini Account Pool")}</h2>
				</div>
				<button
					class="secondary"
					type="button"
					aria-expanded={importExpanded.value}
					aria-controls="import-panel"
					onClick={() => {
						importExpanded.value = !importExpanded.value;
					}}
				>
					<Icon name="plus" />
					{tr("Import accounts")}
					<Icon name="chevron" />
				</button>
			</div>
			<MetricCards />
		</section>
	);
}
