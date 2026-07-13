import type { JSX } from "preact";
import { statusLabel, tr } from "../i18n";
import {
	accountDisplayName,
	formatTime,
	identifierKey,
	isCooling,
	safeNumber,
	sessionLabel,
} from "../logic";
import { accounts, loading, rowBusy, selected } from "../state";
import type { GeminiAccount } from "../types";
import { AccountActions } from "./AccountActions";
import {
	accountIdentity,
	refreshSummary,
	timeCell,
	toggleSelected,
} from "./cells";

const skeletonRows = ["one", "two", "three", "four", "five", "six"] as const;
const skeletonCells = [
	"select",
	"account",
	"status",
	"enabled",
	"session",
	"category",
	"used",
	"refresh",
	"success",
	"failure",
	"outcome",
	"cooldown",
	"errors",
	"source",
	"actions",
] as const;

function AccountRow({ account }: { account: GeminiAccount }): JSX.Element {
	const key = identifierKey(account);
	const enabled = Number(account.enabled) === 1;
	return (
		<tr data-key={key} aria-busy={!!rowBusy.value[key]}>
			<td>
				<input
					type="checkbox"
					aria-label={`Select ${accountDisplayName(account)}`}
					checked={selected.value.has(key)}
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
				<span class={`badge status-${account.status}`}>
					{statusLabel(account.status)}
				</span>
			</td>
			<td>
				<span class="badge">{enabled ? "enabled" : "disabled"}</span>
			</td>
			<td>
				<span class="badge">{sessionLabel(account)}</span>
			</td>
			<td>
				<span class="badge">
					{account.account_category
						? statusLabel(account.account_category)
						: "-"}
				</span>
			</td>
			<td>{timeCell(account.last_used_at_ms)}</td>
			<td>
				<div class="row-main">
					<div class="row-sub">{refreshSummary(account)}</div>
					<div class="row-sub nowrap">
						{formatTime(account.last_refresh_at_ms)}
					</div>
				</div>
			</td>
			<td class="nowrap">{formatTime(account.last_success_at_ms)}</td>
			<td class="nowrap">{formatTime(account.last_failure_at_ms)}</td>
			<td>
				<span class="badge">
					{safeNumber(account.success_count)} /{" "}
					{safeNumber(account.failure_count)}
				</span>
			</td>
			<td>{timeCell(account.cooldown_until_ms, isCooling(account))}</td>
			<td>
				<div class="row-main">
					<div class="row-sub">{account.last_error_code || "-"}</div>
					<div class="row-sub">{account.last_error_message_redacted || ""}</div>
				</div>
			</td>
			<td>
				<div class="row-main">
					<div class="row-sub">{account.source || "-"}</div>
					<div class="row-sub">
						{account.source_name || account.source_id || ""}
					</div>
				</div>
			</td>
			<td>
				<AccountActions account={account} />
			</td>
		</tr>
	);
}

export function AccountRows(): JSX.Element {
	const rows = accounts.value;
	if (loading.value)
		return (
			<>
				<tr class="sr-only">
					<td colSpan={15} role="status">
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
				<td class="empty" colSpan={15}>
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
