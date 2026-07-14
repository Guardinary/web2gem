import type { JSX } from "preact";
import { statusLabel } from "../i18n";
import { accountDisplayName, identifierKey, relativeTime } from "../logic";
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
		</div>
	);
}

export function issueSummary(account: GeminiAccount): string {
	if (account.state === "cooling") {
		const issue = account.issue
			? statusLabel(account.issue)
			: statusLabel("cooling");
		return `${issue} · ${relativeTime(account.cooldown_until_ms)}`;
	}
	return account.issue ? statusLabel(account.issue) : "-";
}

export function timeCell(value: number | null): JSX.Element {
	return <span class="nowrap">{relativeTime(value)}</span>;
}
