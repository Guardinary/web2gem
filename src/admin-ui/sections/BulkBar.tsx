import type { JSX } from "preact";
import { runAction, selectedIdentifiers } from "../actions";
import { tr } from "../i18n";
import { Icon } from "../icons";
import { batchBusy, selected } from "../state";
import type { AccountAction } from "../types";

const batchActions: readonly AccountAction[] = ["refresh", "enable", "disable"];

type BulkBarProps = {
	onSelectVisible: () => void;
	onDeleteVisible: () => void;
};

export function BulkBar({
	onSelectVisible,
	onDeleteVisible,
}: BulkBarProps): JSX.Element {
	return (
		<div
			class={`bulkbar ${selected.value.size ? "active" : "empty"}`}
			role="toolbar"
			aria-label={tr("Selected")}
		>
			<div>
				<strong>{selected.value.size}</strong> {tr("Selected")}
				{!selected.value.size ? (
					<span class="bulk-hint">
						{tr("Select accounts to unlock bulk actions.")}
					</span>
				) : null}
			</div>
			<div class="actions">
				<button type="button" onClick={onSelectVisible}>
					{tr("Select visible")}
				</button>
				{selected.value.size ? (
					<button
						type="button"
						onClick={() => {
							selected.value = new Set();
						}}
					>
						{tr("Clear selection")}
					</button>
				) : null}
				{selected.value.size
					? batchActions.map((action) => (
							<button
								type="button"
								disabled={!!batchBusy.value}
								key={action}
								onClick={() =>
									void runAction(action, selectedIdentifiers(), {
										scope: "batch",
									})
								}
							>
								{tr(
									action === "refresh"
										? "Refresh"
										: action === "enable"
											? "Enable"
											: "Disable",
								)}
								{batchBusy.value === action ? "…" : ""}
							</button>
						))
					: null}
				{selected.value.size ? (
					<details class="action-menu bulk-menu">
						<summary>{tr("More")}</summary>
						<div class="action-menu-items">
							<button
								class="danger"
								type="button"
								disabled={!!batchBusy.value}
								onClick={() =>
									void runAction("delete", selectedIdentifiers(), {
										scope: "batch",
									})
								}
							>
								<Icon name="trash" />
								{tr("Delete selected")}
							</button>
							<button
								class="danger subtle-danger"
								type="button"
								disabled={!!batchBusy.value}
								onClick={onDeleteVisible}
							>
								{tr("Delete visible")}
							</button>
						</div>
					</details>
				) : null}
			</div>
		</div>
	);
}
