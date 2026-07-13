import type { JSX } from "preact";
import { exportMetadata, loadAccounts, runAction } from "../actions";
import { AccountCards, AccountRows } from "../components";
import { Icon } from "../icons";
import { language, tr } from "../i18n";
import { identifier, identifierKey } from "../logic";
import {
	accounts,
	advancedFiltersExpanded,
	categoryFilter,
	cooldownFilter,
	enabledFilter,
	loading,
	nextCursor,
	pageIndex,
	query,
	selected,
	sourceFilter,
	statusFilter,
} from "../state";
import { BulkBar } from "./BulkBar";
import { WorkspaceFilters } from "./WorkspaceFilters";

export function Workspace(): JSX.Element {
	const rows = accounts.value;
	const advancedFilterCount = [
		categoryFilter.value,
		cooldownFilter.value,
		sourceFilter.value.trim(),
	].filter(Boolean).length;
	const hasFilters = Boolean(
		query.value.trim() ||
			statusFilter.value ||
			enabledFilter.value ||
			advancedFilterCount,
	);
	const selectVisible = (): void => {
		selected.value = new Set([...selected.value, ...rows.map(identifierKey)]);
	};
	const deleteVisible = (): void => {
		void runAction("delete", rows.map(identifier), {
			scope: "batch",
			targetLabel: "loaded account(s)",
		});
	};
	const clearFilters = (): void => {
		query.value = "";
		statusFilter.value = "";
		enabledFilter.value = "";
		categoryFilter.value = "";
		cooldownFilter.value = "";
		sourceFilter.value = "";
		advancedFiltersExpanded.value = false;
		void loadAccounts("reset");
	};

	return (
		<section
			id="accounts-workspace"
			class="panel workspace"
			aria-labelledby="accounts-title"
		>
			<div class="panel-head workspace-head">
				<div>
					<span class="eyebrow">{tr("Account workspace")}</span>
					<h2 id="accounts-title" class="panel-title">
						{tr("Account workspace")}
					</h2>
					<p>
						{tr(
							"Search, filter, inspect, and operate on sanitized account metadata.",
						)}
					</p>
				</div>
				<div class="actions">
					<button type="button" onClick={() => void loadAccounts("reset")}>
						<Icon name="refresh" />
						{tr("Refresh")}
					</button>
					<button type="button" onClick={exportMetadata}>
						<Icon name="download" />
						{tr("Export CSV")}
					</button>
				</div>
			</div>
			<WorkspaceFilters
				advancedFilterCount={advancedFilterCount}
				hasFilters={hasFilters}
				onClearFilters={clearFilters}
			/>
			<BulkBar
				onSelectVisible={selectVisible}
				onDeleteVisible={deleteVisible}
			/>
			<div class="table-wrap">
				<table aria-busy={loading.value}>
					<caption class="sr-only">{tr("Account workspace")}</caption>
					<thead>
						<tr>
							<th>{tr("Select")}</th>
							<th>{tr("Account")}</th>
							<th>{tr("Status")}</th>
							<th>{tr("Enabled")}</th>
							<th>{tr("Session")}</th>
							<th>{tr("Category")}</th>
							<th>{tr("Used")}</th>
							<th>{tr("Refresh")}</th>
							<th>{tr("Last success")}</th>
							<th>{tr("Last failure")}</th>
							<th>{tr("Outcome")}</th>
							<th>{tr("Cooldown")}</th>
							<th>{tr("Errors")}</th>
							<th>{tr("Source")}</th>
							<th>{tr("Actions")}</th>
						</tr>
					</thead>
					<tbody>
						<AccountRows />
					</tbody>
				</table>
			</div>
			<AccountCards />
			<div class="pager">
				<button
					type="button"
					disabled={loading.value || pageIndex.value <= 0}
					onClick={() => void loadAccounts("prev")}
				>
					{tr("Previous")}
				</button>
				<span>
					{language.value === "zh-CN"
						? `第 ${pageIndex.value + 1} 页 · 已加载 ${accounts.value.length} 个${nextCursor.value ? "" : " · 已到底"}`
						: `Page ${pageIndex.value + 1} · ${accounts.value.length} loaded${nextCursor.value ? "" : " · end"}`}
				</span>
				<button
					type="button"
					disabled={loading.value || !nextCursor.value}
					onClick={() => void loadAccounts("next")}
				>
					{tr("Next")}
				</button>
			</div>
		</section>
	);
}
