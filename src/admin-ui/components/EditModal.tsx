import type { JSX } from "preact";
import { submitEdit } from "../actions";
import { statusLabel, tr } from "../i18n";
import { editBusy, editDraft, statuses } from "../state";
import { DialogSurface } from "./DialogSurface";

export function EditModal(): JSX.Element | null {
	const draft = editDraft.value;
	if (!draft) return null;
	const close = (): void => {
		if (!editBusy.value) editDraft.value = null;
	};
	const update = (field: keyof typeof draft) => (event: Event) => {
		editDraft.value = {
			...draft,
			[field]: (event.currentTarget as HTMLInputElement | HTMLSelectElement)
				.value,
		};
	};
	return (
		<DialogSurface labelledBy="edit-title" onClose={close}>
			<div class="dialog-head">
				<div>
					<div id="edit-title" class="dialog-title">
						{tr("Edit account")}
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
						onInput={update("label")}
						placeholder={tr("Display label")}
					/>
				</label>
				<div class="field-row">
					<label>
						{tr("Status")}
						<select value={draft.status} onChange={update("status")}>
							{statuses.map((status) => (
								<option key={status} value={status}>
									{statusLabel(status)}
								</option>
							))}
						</select>
					</label>
					<label>
						{tr("Enabled")}
						<select value={draft.enabled} onChange={update("enabled")}>
							<option value="true">{tr("Enabled")}</option>
							<option value="false">{tr("Disabled")}</option>
						</select>
					</label>
				</div>
				<label>
					{tr("State reason")}
					<input
						value={draft.stateReason}
						onInput={update("stateReason")}
						placeholder={tr("Optional status note")}
					/>
				</label>
				<div class="field-row">
					<label>
						{tr("Source")}
						<input
							value={draft.source}
							onInput={update("source")}
							placeholder={tr("Optional source")}
						/>
					</label>
					<label>
						{tr("Source name")}
						<input
							value={draft.sourceName}
							onInput={update("sourceName")}
							placeholder={tr("Optional source name")}
						/>
					</label>
				</div>
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
