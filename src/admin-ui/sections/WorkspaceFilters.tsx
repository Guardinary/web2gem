import type { JSX } from "preact";
import { loadAccounts } from "../actions";
import { Icon } from "../icons";
import { statusLabel, tr } from "../i18n";
import {
	advancedFiltersExpanded,
	categories,
	categoryFilter,
	cooldownFilter,
	enabledFilter,
	query,
	sourceFilter,
	statusFilter,
	statuses,
} from "../state";

type WorkspaceFiltersProps = {
	advancedFilterCount: number;
	hasFilters: boolean;
	onClearFilters: () => void;
};

export function WorkspaceFilters({
	advancedFilterCount,
	hasFilters,
	onClearFilters,
}: WorkspaceFiltersProps): JSX.Element {
	return (
		<fieldset class="filters">
			<legend class="sr-only">{tr("Search")}</legend>
			<label class="search-field">
				<span>{tr("Search")}</span>
				<div class="input-with-icon">
					<Icon name="search" />
					<input
						placeholder={tr("Label, ID, source, status")}
						value={query.value}
						onInput={(event) => {
							query.value = (event.currentTarget as HTMLInputElement).value;
						}}
					/>
				</div>
			</label>
			<label>
				{tr("Status")}
				<select
					value={statusFilter.value}
					onChange={(event) => {
						statusFilter.value = (
							event.currentTarget as HTMLSelectElement
						).value;
					}}
				>
					<option value="">{tr("All statuses")}</option>
					{statuses.map((status) => (
						<option key={status} value={status}>
							{statusLabel(status)}
						</option>
					))}
				</select>
			</label>
			<label>
				{tr("Enabled")}
				<select
					value={enabledFilter.value}
					onChange={(event) => {
						enabledFilter.value = (
							event.currentTarget as HTMLSelectElement
						).value;
					}}
				>
					<option value="">{tr("All")}</option>
					<option value="true">{tr("Enabled")}</option>
					<option value="false">{tr("Disabled")}</option>
				</select>
			</label>
			<button
				class="secondary filter-disclosure"
				type="button"
				aria-expanded={advancedFiltersExpanded.value}
				onClick={() => {
					advancedFiltersExpanded.value = !advancedFiltersExpanded.value;
				}}
			>
				{tr(advancedFiltersExpanded.value ? "Hide filters" : "More filters")}
				{advancedFilterCount ? ` (${advancedFilterCount})` : ""}
				<Icon name="chevron" />
			</button>
			<button
				class="primary filter-submit"
				type="button"
				onClick={() => void loadAccounts("reset")}
			>
				{tr("Apply")}
			</button>
			<button
				class="filter-reset"
				type="button"
				disabled={!hasFilters}
				onClick={onClearFilters}
			>
				{tr("Clear filters")}
			</button>
			{advancedFiltersExpanded.value ? (
				<div class="advanced-filters">
					<label>
						{tr("Category")}
						<select
							value={categoryFilter.value}
							onChange={(event) => {
								categoryFilter.value = (
									event.currentTarget as HTMLSelectElement
								).value;
							}}
						>
							<option value="">{tr("All categories")}</option>
							{categories.map((category) => (
								<option key={category} value={category}>
									{statusLabel(category)}
								</option>
							))}
						</select>
					</label>
					<label>
						{tr("Cooldown")}
						<select
							value={cooldownFilter.value}
							onChange={(event) => {
								cooldownFilter.value = (
									event.currentTarget as HTMLSelectElement
								).value;
							}}
						>
							<option value="">{tr("All")}</option>
							<option value="active">{tr("Not cooling")}</option>
							<option value="cooling">{tr("Cooling")}</option>
						</select>
					</label>
					<label>
						{tr("Source")}
						<input
							value={sourceFilter.value}
							onInput={(event) => {
								sourceFilter.value = (
									event.currentTarget as HTMLInputElement
								).value;
							}}
						/>
					</label>
				</div>
			) : null}
		</fieldset>
	);
}
