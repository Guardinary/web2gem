import type { JSX } from "preact";
import { loadAccounts, runAction } from "../actions";
import { AccountCards, AccountRows } from "../components";
import { language, tr } from "../i18n";
import { Icon } from "../icons";
import { identifier, identifierKey } from "../logic";
import { hasFilters } from "../selectors";
import {
	accounts,
	loading,
	nextCursor,
	pageIndex,
	query,
	selected,
	stateFilter,
} from "../state";
import { BulkBar } from "./BulkBar";
import { WorkspaceFilters } from "./WorkspaceFilters";

export function Workspace(): JSX.Element {
	const rows = accounts.value;
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
		stateFilter.value = "";
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
					<p>{tr("Search accounts and manage their availability.")}</p>
				</div>
				<div class="actions">
					<button type="button" onClick={() => void loadAccounts("reset")}>
						<Icon name="refresh" />
						{tr("Refresh")}
					</button>
				</div>
			</div>
			<WorkspaceFilters
				hasFilters={hasFilters.value}
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
							<th>{tr("State")}</th>
							<th>{tr("Last used")}</th>
							<th>{tr("Current issue")}</th>
							<th>{tr("Last refresh")}</th>
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
