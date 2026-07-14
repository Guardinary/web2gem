import { useComputed } from "@preact/signals";
import type { JSX } from "preact";
import { openEdit, runAction } from "../actions";
import { tr } from "../i18n";
import { Icon } from "../icons";
import {
	accountBusyLabel,
	accountDisplayName,
	identifier,
	identifierKey,
} from "../logic";
import { rowBusy } from "../state";
import type { AccountAction, GeminiAccount } from "../types";

export function AccountActions({
	account,
}: {
	account: GeminiAccount;
}): JSX.Element {
	const key = identifierKey(account);
	const busy = useComputed(() => rowBusy.value[key] || "").value;
	const label = accountDisplayName(account);
	const run = (action: AccountAction): void => {
		void runAction(action, [identifier(account)], {
			scope: "row",
			targetLabel: `account “${label}”`,
		});
	};
	return (
		<div class="account-actions">
			<button
				type="button"
				disabled={!!busy}
				aria-label={`${tr("Refresh")} ${label}`}
				onClick={() => run("refresh")}
			>
				<Icon name="refresh" />
				{busy === "refresh" ? `${tr("Refreshing")}…` : tr("Refresh")}
			</button>
			<details class="action-menu">
				<summary aria-label={`${tr("More")} ${label}`}>{tr("More")}</summary>
				<div class="action-menu-items">
					<button
						type="button"
						disabled={!!busy}
						onClick={() => openEdit(account)}
					>
						<Icon name="edit" />
						{tr("Rename")}
					</button>
					<button
						type="button"
						disabled={!!busy}
						onClick={() => run(account.enabled ? "disable" : "enable")}
					>
						{tr(account.enabled ? "Disable" : "Enable")}
					</button>
					<button
						type="button"
						disabled={!!busy}
						class="danger"
						onClick={() => run("delete")}
					>
						<Icon name="trash" />
						{tr("Delete")}
					</button>
				</div>
			</details>
			{busy ? (
				<span class="row-busy" role="status">
					{accountBusyLabel(busy)}
				</span>
			) : null}
		</div>
	);
}
