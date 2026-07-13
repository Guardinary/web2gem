import type { JSX } from "preact";
import { resetImport, submitImport } from "../actions";
import { tr } from "../i18n";
import {
	importBatch,
	importBusy,
	importExpanded,
	importLabel,
	importPsid,
	importPsidts,
} from "../state";

export function ImportPanel(): JSX.Element {
	return (
		<section
			id="import-panel"
			class={`panel disclosure ${importExpanded.value ? "open" : ""}`}
			hidden={!importExpanded.value}
		>
			<div class="panel-head">
				<div>
					<div class="panel-title">{tr("Import accounts")}</div>
					<p>{tr("Add one account or paste a batch when needed.")}</p>
				</div>
				<button
					type="button"
					onClick={() => {
						importExpanded.value = false;
					}}
				>
					{tr("Collapse")}
				</button>
			</div>
			<div class="panel-body">
				<form
					class="import-grid"
					aria-busy={importBusy.value}
					onSubmit={(event) => void submitImport(event)}
				>
					<label>
						{tr("Label")}
						<input
							placeholder={tr("Optional display label")}
							value={importLabel.value}
							onInput={(event) => {
								importLabel.value = (
									event.currentTarget as HTMLInputElement
								).value;
							}}
						/>
					</label>
					<label>
						__Secure-1PSID
						<input
							autocomplete="off"
							placeholder={tr("Value only")}
							value={importPsid.value}
							onInput={(event) => {
								importPsid.value = (
									event.currentTarget as HTMLInputElement
								).value;
							}}
						/>
					</label>
					<label>
						__Secure-1PSIDTS
						<input
							autocomplete="off"
							placeholder={tr("Value only")}
							value={importPsidts.value}
							onInput={(event) => {
								importPsidts.value = (
									event.currentTarget as HTMLInputElement
								).value;
							}}
						/>
					</label>
					<label class="wide-field">
						{tr("Batch import")}
						<textarea
							rows={5}
							autocomplete="off"
							placeholder={tr("One account per line: PSID PSIDTS label")}
							value={importBatch.value}
							onInput={(event) => {
								importBatch.value = (
									event.currentTarget as HTMLTextAreaElement
								).value;
							}}
						/>
					</label>
					<div class="actions wide-field">
						<button class="primary" type="submit" disabled={importBusy.value}>
							{importBusy.value ? tr("Importing") : tr("Import")}
						</button>
						<button type="button" onClick={resetImport}>
							{tr("Reset")}
						</button>
					</div>
				</form>
			</div>
		</section>
	);
}
