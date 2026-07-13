import type { JSX } from "preact";
import { Icon } from "../icons";
import { tr } from "../i18n";
import { resultSummary } from "../logic";
import { diagnosticsExpanded, lastDiagnostics } from "../state";

export function Diagnostics(): JSX.Element | null {
	if (!lastDiagnostics.value) return null;
	return (
		<section class="panel diagnostics">
			<button
				class="diagnostics-toggle"
				type="button"
				aria-expanded={diagnosticsExpanded.value}
				onClick={() => {
					diagnosticsExpanded.value = !diagnosticsExpanded.value;
				}}
			>
				<span>
					<strong>{tr("Diagnostics")}</strong>
					<small>{tr("Latest sanitized mutation summary")}</small>
				</span>
				<Icon name="chevron" />
			</button>
			{diagnosticsExpanded.value ? (
				<div class="panel-body">
					<code>{resultSummary("last action", lastDiagnostics.value)}</code>
				</div>
			) : null}
		</section>
	);
}
