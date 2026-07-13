import type { JSX } from "preact";
import { memo } from "preact/compat";
import { useComputed } from "@preact/signals";
import { statusLabel, tr } from "../i18n";
import {
	accountDisplayName,
	formatTime,
	identifierKey,
	isCooling,
	relativeTime,
	safeNumber,
	sessionLabel,
} from "../logic";
import { accounts, loading, rowBusy, selected } from "../state";
import type { GeminiAccount } from "../types";
import { AccountActions } from "./AccountActions";
import { accountIdentity, refreshSummary, toggleSelected } from "./cells";

const AccountCard = memo(function AccountCardView({
	account,
}: {
	account: GeminiAccount;
}): JSX.Element {
	const key = identifierKey(account);
	const enabled = Number(account.enabled) === 1;
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
				<span class={`badge status-${account.status}`}>
					{statusLabel(account.status)}
				</span>
				<span class="badge">{enabled ? "enabled" : "disabled"}</span>
				<span class="badge">{sessionLabel(account)}</span>
			</div>
			<dl class="account-facts">
				<div>
					<dt>{tr("Category")}</dt>
					<dd>
						{account.account_category
							? statusLabel(account.account_category)
							: "-"}
					</dd>
				</div>
				<div>
					<dt>{tr("Last used")}</dt>
					<dd>{relativeTime(account.last_used_at_ms)}</dd>
				</div>
				<div>
					<dt>{tr("Outcome")}</dt>
					<dd>
						{safeNumber(account.success_count)} /{" "}
						{safeNumber(account.failure_count)}
					</dd>
				</div>
				<div>
					<dt>{tr("Cooldown")}</dt>
					<dd>
						{isCooling(account) ? relativeTime(account.cooldown_until_ms) : "-"}
					</dd>
				</div>
			</dl>
			<details class="account-details">
				<summary>{tr("More account details")}</summary>
				<dl class="account-facts secondary">
					<div>
						<dt>{tr("Refresh")}</dt>
						<dd>{refreshSummary(account)}</dd>
					</div>
					<div>
						<dt>{tr("Last success")}</dt>
						<dd>{formatTime(account.last_success_at_ms)}</dd>
					</div>
					<div>
						<dt>{tr("Last failure")}</dt>
						<dd>{formatTime(account.last_failure_at_ms)}</dd>
					</div>
					<div>
						<dt>{tr("Source")}</dt>
						<dd>
							{account.source_name ||
								account.source_id ||
								account.source ||
								"-"}
						</dd>
					</div>
					<div class="wide">
						<dt>{tr("Last error")}</dt>
						<dd>
							{account.last_error_message_redacted ||
								account.last_error_code ||
								"-"}
						</dd>
					</div>
				</dl>
			</details>
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
