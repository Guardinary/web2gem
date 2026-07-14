import type { JSX } from "preact";
import { submitEdit } from "../actions";
import { tr } from "../i18n";
import { editBusy, editDraft } from "../state";
import { DialogSurface } from "./DialogSurface";

export function EditModal(): JSX.Element | null {
	const draft = editDraft.value;
	if (!draft) return null;
	const close = (): void => {
		if (!editBusy.value) editDraft.value = null;
	};
	return (
		<DialogSurface labelledBy="edit-title" onClose={close}>
			<div class="dialog-head">
				<div>
					<div id="edit-title" class="dialog-title">
						{tr("Rename account")}
					</div>
					<div class="help">{draft.key}</div>
				</div>
				<button type="button" disabled={editBusy.value} onClick={close}>
					{tr("Close")}
				</button>
			</div>
			<form
				id="edit-form"
				class="grid"
				aria-busy={editBusy.value}
				onSubmit={(event) => void submitEdit(event)}
			>
				<label>
					{tr("Label")}
					<input
						data-dialog-initial
						value={draft.label}
						onInput={(event) => {
							editDraft.value = {
								...draft,
								label: (event.currentTarget as HTMLInputElement).value,
							};
						}}
						placeholder={tr("Display label")}
					/>
				</label>
				<div class="actions">
					<button class="primary" type="submit" disabled={editBusy.value}>
						{editBusy.value ? `${tr("Saving")}…` : tr("Save changes")}
					</button>
					<button type="button" disabled={editBusy.value} onClick={close}>
						{tr("Cancel")}
					</button>
				</div>
			</form>
		</DialogSurface>
	);
}
