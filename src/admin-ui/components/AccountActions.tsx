import type { JSX } from "preact";
import { useComputed } from "@preact/signals";
import { openEdit, runAction } from "../actions";
import { Icon } from "../icons";
import { tr } from "../i18n";
import {
	accountBusyLabel,
	accountDisplayName,
	identifier,
	identifierKey,
} from "../logic";
import { rowBusy } from "../state";
import type { GeminiAccount } from "../types";

export function AccountActions({
	account,
}: {
	account: GeminiAccount;
}): JSX.Element {
	const key = identifierKey(account);
	const enabled = Number(account.enabled) === 1;
	const busy = useComputed(() => rowBusy.value[key] || "").value;
	const label = accountDisplayName(account);
	const run = (action: string): void => {
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
				aria-label={`${tr("Check")} ${label}`}
				onClick={() => run("check")}
			>
				<Icon name="check" />
				{busy === "check" ? `${tr("Checking")}…` : tr("Check")}
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
						{tr("Edit")}
					</button>
					<button
						type="button"
						disabled={!!busy}
						onClick={() => run("refresh")}
					>
						<Icon name="refresh" />
						{tr("Refresh")}
					</button>
					<button
						type="button"
						disabled={!!busy}
						onClick={() => run(enabled ? "disable" : "enable")}
					>
						{tr(enabled ? "Disable" : "Enable")}
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
