import type { JSX } from "preact";
import { resolveConfirmation } from "../actions";
import { language, tr } from "../i18n";
import { destructiveConfirmationText } from "../logic";
import { confirmationDraft } from "../state";
import { DialogSurface } from "./DialogSurface";

export function ConfirmationModal(): JSX.Element | null {
	const draft = confirmationDraft.value;
	if (!draft) return null;
	const copy = destructiveConfirmationText(draft.count, draft.targetLabel);
	const localizedCopy =
		language.value === "zh-CN"
			? {
					title: tr(draft.count === 1 ? "Delete account?" : "Delete accounts?"),
					description: tr(
						"This action permanently deletes the selected account metadata and cannot be undone.",
					),
					confirmLabel: tr(
						draft.count === 1 ? "Delete account" : "Delete accounts",
					),
				}
			: copy;
	return (
		<DialogSurface
			labelledBy="confirm-title"
			describedBy="confirm-description"
			onClose={() => resolveConfirmation(false)}
		>
			<div class="dialog-head">
				<div>
					<div id="confirm-title" class="dialog-title">
						{localizedCopy.title}
					</div>
					<p id="confirm-description" class="dialog-copy">
						{localizedCopy.description}
					</p>
				</div>
			</div>
			<div class="actions dialog-actions">
				<button
					type="button"
					class="danger danger-solid"
					onClick={() => resolveConfirmation(true)}
				>
					{localizedCopy.confirmLabel}
				</button>
				<button
					type="button"
					data-dialog-initial
					onClick={() => resolveConfirmation(false)}
				>
					{tr("Cancel")}
				</button>
			</div>
		</DialogSurface>
	);
}
