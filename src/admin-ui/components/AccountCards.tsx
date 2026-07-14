import { useComputed } from "@preact/signals";
import type { JSX } from "preact";
import { memo } from "preact/compat";
import { statusLabel, tr } from "../i18n";
import { accountDisplayName, identifierKey, relativeTime } from "../logic";
import { accounts, loading, rowBusy, selected } from "../state";
import type { GeminiAccount } from "../types";
import { AccountActions } from "./AccountActions";
import { accountIdentity, issueSummary, toggleSelected } from "./cells";

const AccountCard = memo(function AccountCardView({
	account,
}: {
	account: GeminiAccount;
}): JSX.Element {
	const key = identifierKey(account);
	const isSelected = useComputed(() => selected.value.has(key));
	const busy = useComputed(() => !!rowBusy.value[key]);
	return (
		<article class="account-card" aria-busy={busy.value}>
			<div class="account-card-head">
				<label class="account-select">
					<input
						type="checkbox"
						checked={isSelected.value}
						onChange={(event) =>
							toggleSelected(
								account,
								(event.currentTarget as HTMLInputElement).checked,
							)
						}
					/>
					<span class="sr-only">Select {accountDisplayName(account)}</span>
				</label>
				{accountIdentity(account)}
			</div>
			<div class="account-card-badges">
				<span class={`badge status-${account.state}`}>
					{statusLabel(account.state)}
				</span>
			</div>
			<dl class="account-facts">
				<div>
					<dt>{tr("Last used")}</dt>
					<dd>{relativeTime(account.last_used_at_ms)}</dd>
				</div>
				<div>
					<dt>{tr("Current issue")}</dt>
					<dd>{issueSummary(account)}</dd>
				</div>
				<div>
					<dt>{tr("Last refresh")}</dt>
					<dd>{relativeTime(account.last_refresh_at_ms)}</dd>
				</div>
			</dl>
			<AccountActions account={account} />
		</article>
	);
});

export function AccountCards(): JSX.Element {
	if (loading.value)
		return (
			<div class="card-state" role="status">
				{tr("Loading accounts")}…
			</div>
		);
	if (!accounts.value.length)
		return (
			<div class="card-state">
				{tr("No accounts found")}.{" "}
				{tr("Connect with an admin key or adjust the current filters.")}
			</div>
		);
	return (
		<div class="account-cards">
			{accounts.value.map((account) => (
				<AccountCard account={account} key={identifierKey(account)} />
			))}
		</div>
	);
}
