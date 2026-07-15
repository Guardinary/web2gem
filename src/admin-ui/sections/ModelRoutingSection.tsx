import type { JSX } from "preact";
import {
	moveModelRoute,
	resetModelRoutePriorityAction,
	saveModelRoutePriority,
} from "../actions";
import { tr } from "../i18n";
import {
	connectionVerified,
	modelRouting,
	modelRoutingDrafts,
	modelRoutingLoading,
} from "../state";
import type { ModelFamily, ModelRoutingFamily } from "../types";

const FAMILY_ORDER = ["pro", "flash", "flash_lite"] as const;

export function ModelRoutingSection(): JSX.Element {
	const overview = modelRouting.value;
	return (
		<section class="section-block" aria-labelledby="model-routing-title">
			<div class="section-heading">
				<div>
					<span class="eyebrow">{tr("Internal routing")}</span>
					<h2 id="model-routing-title">{tr("Model route priority")}</h2>
					<p>
						{tr("Public names share one ordered internal policy per family.")}
					</p>
				</div>
			</div>
			{modelRoutingLoading.value ? (
				<div class="panel model-routing-state" role="status">
					{tr("Loading model routing")}
				</div>
			) : overview ? (
				<div class="model-routing-grid">
					{FAMILY_ORDER.map((family) => {
						const saved = overview.families.find(
							(item) => item.family === family,
						);
						return saved ? (
							<ModelRoutingCard key={family} family={saved} />
						) : null;
					})}
				</div>
			) : (
				<div class="panel model-routing-state">
					{connectionVerified.value
						? tr("Model routing is unavailable")
						: tr("Connect to configure model routing")}
				</div>
			)}
		</section>
	);
}

function ModelRoutingCard({
	family,
}: {
	family: ModelRoutingFamily;
}): JSX.Element {
	const draft = modelRoutingDrafts.value[family.family];
	return (
		<article class="panel model-routing-card">
			<header class="model-routing-head">
				<div>
					<h3>{familyLabel(family.family)}</h3>
					<p class="route-public-names">{family.publicNames.join(" · ")}</p>
				</div>
				<span class={`badge ${family.configured ? "status-available" : ""}`}>
					{family.configured ? tr("Configured") : tr("Discovery order")}
				</span>
			</header>
			<ol class="model-route-list">
				{draft.routes.length ? (
					draft.routes.map((route, index) => (
						<li
							class={`model-route-row ${route.available ? "" : "route-unavailable"}`}
							key={`${route.providerModelId}:${route.capacity}:${route.capacityField}:${route.modelNumber}`}
						>
							<div class="route-order-actions">
								<button
									class="secondary icon-button"
									type="button"
									disabled={draft.busy || index === 0}
									aria-label={`${tr("Move up")} ${route.providerModelId}`}
									onClick={() => moveModelRoute(family.family, index, -1)}
								>
									↑
								</button>
								<button
									class="secondary icon-button"
									type="button"
									disabled={draft.busy || index === draft.routes.length - 1}
									aria-label={`${tr("Move down")} ${route.providerModelId}`}
									onClick={() => moveModelRoute(family.family, index, 1)}
								>
									↓
								</button>
							</div>
							<div class="route-main">
								<div class="route-title-line">
									<code>{route.providerModelId}</code>
									{route.label ? (
										<span class="badge">{route.label}</span>
									) : null}
									<span
										class={`badge ${route.available ? "status-available" : "status-disabled"}`}
									>
										{route.available ? tr("Available") : tr("Unavailable")}
									</span>
								</div>
								<div class="route-facts">
									<span>
										{tr("Capacity")} {route.capacity}
									</span>
									<span>
										{tr("Field")} {route.capacityField}
									</span>
									<span>
										{tr("Model number")} {route.modelNumber}
									</span>
									<span>
										{route.accountCount} {tr("accounts")}
									</span>
									{route.configured ? <span>{tr("Saved route")}</span> : null}
								</div>
							</div>
						</li>
					))
				) : (
					<li class="model-route-empty">{tr("No discovered routes")}</li>
				)}
			</ol>
			{draft.error ? (
				<p class="route-error" role="alert">
					{draft.error}
				</p>
			) : null}
			<footer class="model-routing-actions">
				{draft.dirty ? (
					<span class="route-dirty">{tr("Unsaved order")}</span>
				) : (
					<span />
				)}
				<button
					class="secondary"
					type="button"
					disabled={draft.busy || !family.configured}
					onClick={() => void resetModelRoutePriorityAction(family.family)}
				>
					{tr("Reset to discovery order")}
				</button>
				<button
					class="primary"
					type="button"
					disabled={draft.busy || !draft.routes.length}
					onClick={() => void saveModelRoutePriority(family.family)}
				>
					{draft.busy ? tr("Saving") : tr("Save order")}
				</button>
			</footer>
		</article>
	);
}

function familyLabel(family: ModelFamily): string {
	if (family === "pro") return tr("Pro family");
	if (family === "flash") return tr("Flash family");
	return tr("Flash Lite family");
}
