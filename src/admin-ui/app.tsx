import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import {
	clearAdminKey,
	exportMetadata,
	loadAccounts,
	resetImport,
	restoreAdminKey,
	runAction,
	saveAdminKey,
	selectedIdentifiers,
	submitImport,
} from "./actions";
import {
	AccountCards,
	AccountRows,
	ConfirmationModal,
	EditModal,
	MetricCards,
} from "./components";
import { identifier, identifierKey, resultSummary } from "./logic";
import {
	adminKey,
	accounts,
	batchBusy,
	categories,
	categoryFilter,
	cooldownFilter,
	enabledFilter,
	importBatch,
	importBusy,
	importLabel,
	importPsid,
	importPsidts,
	keyStorageMode,
	lastDiagnostics,
	loading,
	nextCursor,
	pageIndex,
	query,
	selected,
	sourceFilter,
	statusFilter,
	statuses,
	toastItems,
} from "./state";

export function App(): JSX.Element {
	useEffect(() => {
		restoreAdminKey();
		if (adminKey.value) void loadAccounts("reset");
	}, []);

	const rows = accounts.value;
	const selectVisible = (): void => {
		selected.value = new Set([...selected.value, ...rows.map(identifierKey)]);
	};
	const deleteVisible = (): void => {
		void runAction("delete", rows.map(identifier), {
			scope: "batch",
			targetLabel: "loaded account(s)",
		});
	};

	return (
		<main class="shell">
			<div class="topbar">
				<div class="brand">
					<span class="brand-mark">G</span>
					<div>
						<h1>Gemini Account Pool</h1>
						<div class="subtitle">
							D1-backed admin console for Gemini Web sessions
						</div>
					</div>
				</div>
				<form
					class="auth"
					onSubmit={(event) => {
						event.preventDefault();
						saveAdminKey();
						void loadAccounts("reset");
					}}
				>
					<label>
						Admin key
						<input
							type="password"
							autocomplete="current-password"
							placeholder="ADMIN_KEY"
							value={adminKey.value}
							onInput={(event) => {
								adminKey.value = (
									event.currentTarget as HTMLInputElement
								).value;
							}}
						/>
					</label>
					<label>
						Storage
						<select
							value={keyStorageMode.value}
							onChange={(event) => {
								keyStorageMode.value =
									(event.currentTarget as HTMLSelectElement).value === "local"
										? "local"
										: "session";
							}}
						>
							<option value="session">Session</option>
							<option value="local">Local</option>
						</select>
					</label>
					<button class="primary" type="submit" disabled={loading.value}>
						{loading.value ? "Loading…" : "Save"}
					</button>
					<button type="button" onClick={clearAdminKey}>
						Clear
					</button>
				</form>
			</div>

			<section class="layout">
				<div class="grid">
					<section class="panel">
						<div class="panel-head">
							<div class="panel-title">Import Gemini account</div>
						</div>
						<div class="panel-body">
							<form class="grid" onSubmit={(event) => void submitImport(event)}>
								<label>
									Label
									<input
										placeholder="Optional display label"
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
										placeholder="Value only"
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
										placeholder="Value only"
										value={importPsidts.value}
										onInput={(event) => {
											importPsidts.value = (
												event.currentTarget as HTMLInputElement
											).value;
										}}
									/>
								</label>
								<label>
									Batch
									<textarea
										rows={5}
										autocomplete="off"
										placeholder="PSID PSIDTS label"
										value={importBatch.value}
										onInput={(event) => {
											importBatch.value = (
												event.currentTarget as HTMLTextAreaElement
											).value;
										}}
									/>
								</label>
								<div class="help">
									Only paste the value after the equals sign. Do not paste
									cookie names, equals signs, semicolons, full Cookie headers,
									or JSON blobs.
								</div>
								<div class="actions">
									<button
										class="primary"
										type="submit"
										disabled={importBusy.value}
									>
										{importBusy.value ? "Importing…" : "Import"}
									</button>
									<button type="button" onClick={resetImport}>
										Reset
									</button>
								</div>
							</form>
						</div>
					</section>
					<section class="panel">
						<div class="panel-head">
							<div class="panel-title">Batch actions</div>
							<span class="badge">{selected.value.size} selected</span>
						</div>
						<div class="panel-body">
							<div class="actions">
								{["refresh", "check", "enable", "disable"].map((action) => (
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
										{batchBusy.value === action
											? `${action.slice(0, 1).toUpperCase() + action.slice(1)}…`
											: action.slice(0, 1).toUpperCase() + action.slice(1)}
									</button>
								))}
								<button
									type="button"
									disabled={!!batchBusy.value}
									class="danger"
									onClick={() =>
										void runAction("delete", selectedIdentifiers(), {
											scope: "batch",
										})
									}
								>
									Delete
								</button>
								<button
									type="button"
									disabled={!!batchBusy.value}
									class="danger"
									onClick={deleteVisible}
								>
									Delete loaded
								</button>
								<button
									id="export-metadata"
									type="button"
									onClick={exportMetadata}
								>
									Export metadata
								</button>
							</div>
							{lastDiagnostics.value ? (
								<p class="help">
									{resultSummary("last action", lastDiagnostics.value)}
								</p>
							) : null}
							<p class="help">
								Actions use stable account IDs from the sanitized admin API
								response. No session secrets are displayed here.
							</p>
						</div>
					</section>
				</div>

				<section>
					<MetricCards />
					<section class="panel">
						<div class="panel-head">
							<div class="panel-title">Accounts</div>
							<div class="actions">
								<button
									type="button"
									onClick={() => void loadAccounts("reset")}
								>
									Reload
								</button>
								<button type="button" onClick={selectVisible}>
									Select visible
								</button>
								<button
									type="button"
									onClick={() => {
										selected.value = new Set();
									}}
								>
									Clear selection
								</button>
							</div>
						</div>
						<div class="panel-body">
							<div class="filters">
								<label>
									Search
									<input
										placeholder="Label, ID, row ID, source, status"
										value={query.value}
										onInput={(event) => {
											query.value = (
												event.currentTarget as HTMLInputElement
											).value;
										}}
									/>
								</label>
								<label>
									Status
									<select
										value={statusFilter.value}
										onChange={(event) => {
											statusFilter.value = (
												event.currentTarget as HTMLSelectElement
											).value;
										}}
									>
										{["", ...statuses].map((status) => (
											<option key={status || "all"} value={status}>
												{status || "All statuses"}
											</option>
										))}
									</select>
								</label>
								<label>
									Enabled
									<select
										value={enabledFilter.value}
										onChange={(event) => {
											enabledFilter.value = (
												event.currentTarget as HTMLSelectElement
											).value;
										}}
									>
										<option value="">All</option>
										<option value="true">Enabled</option>
										<option value="false">Disabled</option>
									</select>
								</label>
								<label>
									Category
									<select
										id="category-filter"
										value={categoryFilter.value}
										onChange={(event) => {
											categoryFilter.value = (
												event.currentTarget as HTMLSelectElement
											).value;
										}}
									>
										<option value="">All categories</option>
										{categories.map((category) => (
											<option key={category} value={category}>
												{category}
											</option>
										))}
									</select>
								</label>
								<label>
									Cooldown
									<select
										id="cooldown-filter"
										value={cooldownFilter.value}
										onChange={(event) => {
											cooldownFilter.value = (
												event.currentTarget as HTMLSelectElement
											).value;
										}}
									>
										<option value="">All</option>
										<option value="active">Not cooling</option>
										<option value="cooling">Cooling</option>
									</select>
								</label>
								<label>
									Source
									<input
										placeholder="source/source_id/source_name"
										value={sourceFilter.value}
										onInput={(event) => {
											sourceFilter.value = (
												event.currentTarget as HTMLInputElement
											).value;
										}}
									/>
								</label>
								<button
									type="button"
									onClick={() => void loadAccounts("reset")}
								>
									Apply
								</button>
							</div>
						</div>
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th class="nowrap">Select</th>
										<th>Account</th>
										<th>Status</th>
										<th>Enabled</th>
										<th>Session</th>
										<th>Category</th>
										<th>Used</th>
										<th>Refresh</th>
										<th>Last success</th>
										<th>Last failure</th>
										<th>Outcome</th>
										<th>Cooldown</th>
										<th>Errors</th>
										<th>Source</th>
										<th>Actions</th>
									</tr>
								</thead>
								<tbody>
									<AccountRows />
								</tbody>
							</table>
						</div>
						<AccountCards />
						<div class="pager">
							<button
								type="button"
								disabled={loading.value || pageIndex.value <= 0}
								onClick={() => void loadAccounts("prev")}
							>
								Previous
							</button>
							<span>
								Page {pageIndex.value + 1} - {accounts.value.length} loaded
								{nextCursor.value ? "" : " (end)"}
							</span>
							<button
								id="next-page"
								type="button"
								disabled={loading.value || !nextCursor.value}
								onClick={() => void loadAccounts("next")}
							>
								Next
							</button>
						</div>
					</section>
				</section>
			</section>
			<EditModal />
			<ConfirmationModal />
			<div class="toast" aria-atomic="true">
				{toastItems.value.map((item) => (
					<div
						key={item.id}
						role={item.kind === "error" ? "alert" : "status"}
						class={`toast-item${item.kind === "error" ? " error" : ""}`}
					>
						{item.message}
					</div>
				))}
			</div>
		</main>
	);
}
