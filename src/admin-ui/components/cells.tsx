import type { JSX } from "preact";
import {
	accountDisplayName,
	formatTime,
	identifierKey,
	relativeTime,
} from "../logic";
import { selected } from "../state";
import type { GeminiAccount } from "../types";

export function toggleSelected(account: GeminiAccount, checked: boolean): void {
	const key = identifierKey(account);
	const next = new Set(selected.value);
	if (checked) next.add(key);
	else next.delete(key);
	selected.value = next;
}

export function accountIdentity(account: GeminiAccount): JSX.Element {
	return (
		<div class="row-main">
			<div class="row-title">{accountDisplayName(account)}</div>
			<div class="row-sub">{account.id}</div>
			<div class="row-sub">{account.row_id}</div>
		</div>
	);
}

export function refreshSummary(account: GeminiAccount): string {
	return (
		[
			account.last_refresh_at_ms
				? `ok ${relativeTime(account.last_refresh_at_ms)}`
				: "",
			account.last_refresh_attempt_at_ms
				? `try ${relativeTime(account.last_refresh_attempt_at_ms)}`
				: "",
		]
			.filter(Boolean)
			.join(" / ") || "-"
	);
}

export function timeCell(
	value: number | null,
	showRelative = true,
): JSX.Element {
	return (
		<div class="row-main">
			<div class="row-sub nowrap">
				{showRelative ? relativeTime(value) : "-"}
			</div>
			<div class="row-sub nowrap">{formatTime(value)}</div>
		</div>
	);
}
