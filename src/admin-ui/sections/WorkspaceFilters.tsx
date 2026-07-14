import type { JSX } from "preact";
import { loadAccounts } from "../actions";
import { statusLabel, tr } from "../i18n";
import { Icon } from "../icons";
import { accountStates, query, stateFilter } from "../state";
import type { GeminiAccountState } from "../types";

type WorkspaceFiltersProps = {
	hasFilters: boolean;
	onClearFilters: () => void;
};

export function WorkspaceFilters({
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
						placeholder={tr("Label or account ID")}
						value={query.value}
						onInput={(event) => {
							query.value = (event.currentTarget as HTMLInputElement).value;
						}}
					/>
				</div>
			</label>
			<label>
				{tr("State")}
				<select
					value={stateFilter.value}
					onChange={(event) => {
						stateFilter.value = (event.currentTarget as HTMLSelectElement)
							.value as GeminiAccountState | "";
					}}
				>
					<option value="">{tr("All states")}</option>
					{accountStates.map((state) => (
						<option key={state} value={state}>
							{statusLabel(state)}
						</option>
					))}
				</select>
			</label>
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
		</fieldset>
	);
}
