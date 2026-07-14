import { useComputed } from "@preact/signals";
import type { JSX } from "preact";
import { memo } from "preact/compat";
import { statusLabel, tr } from "../i18n";
import { accountDisplayName, identifierKey } from "../logic";
import { accounts, loading, rowBusy, selected } from "../state";
import type { GeminiAccount } from "../types";
import { AccountActions } from "./AccountActions";
import {
	accountIdentity,
	issueSummary,
	timeCell,
	toggleSelected,
} from "./cells";

const skeletonRows = ["one", "two", "three", "four", "five"] as const;
const skeletonCells = [
	"select",
	"account",
	"state",
	"used",
	"issue",
	"refresh",
	"actions",
] as const;

const AccountRow = memo(function AccountRowView({
	account,
}: {
	account: GeminiAccount;
}): JSX.Element {
	const key = identifierKey(account);
	const isSelected = useComputed(() => selected.value.has(key));
	const busy = useComputed(() => !!rowBusy.value[key]);
	return (
		<tr data-key={key} aria-busy={busy.value}>
			<td>
				<input
					type="checkbox"
					aria-label={`Select ${accountDisplayName(account)}`}
					checked={isSelected.value}
					onChange={(event) =>
						toggleSelected(
							account,
							(event.currentTarget as HTMLInputElement).checked,
						)
					}
				/>
			</td>
			<td>{accountIdentity(account)}</td>
			<td>
				<span class={`badge status-${account.state}`}>
					{statusLabel(account.state)}
				</span>
			</td>
			<td>{timeCell(account.last_used_at_ms)}</td>
			<td>{issueSummary(account)}</td>
			<td>{timeCell(account.last_refresh_at_ms)}</td>
			<td>
				<AccountActions account={account} />
			</td>
		</tr>
	);
});

export function AccountRows(): JSX.Element {
	const rows = accounts.value;
	if (loading.value)
		return (
			<>
				<tr class="sr-only">
					<td colSpan={7} role="status">
						{tr("Loading accounts")}…
					</td>
				</tr>
				{skeletonRows.map((rowName) => (
					<tr class="skeleton-row" inert={true} key={`skeleton-${rowName}`}>
						{skeletonCells.map((cellName) => (
							<td key={`skeleton-${rowName}-${cellName}`}>
								<span aria-hidden="true" class="skeleton-line" />
							</td>
						))}
					</tr>
				))}
			</>
		);
	if (!rows.length)
		return (
			<tr>
				<td class="empty" colSpan={7}>
					{tr("No accounts found")}.{" "}
					{tr("Connect with an admin key or adjust the current filters.")}
				</td>
			</tr>
		);
	return (
		<>
			{rows.map((account) => (
				<AccountRow account={account} key={identifierKey(account)} />
			))}
		</>
	);
}
