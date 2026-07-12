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
import { Icon } from "./icons";
import { language, setLanguage, statusLabel, tr } from "./i18n";
import { identifier, identifierKey, resultSummary } from "./logic";
import {
	adminKey,
	accounts,
	batchBusy,
	categories,
	categoryFilter,
	cooldownFilter,
	diagnosticsExpanded,
	enabledFilter,
	importBatch,
	importBusy,
	importExpanded,
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
import { setThemePreference, themePreference } from "./theme";

const batchActions = ["check", "refresh", "enable", "disable"] as const;

export function App(): JSX.Element {
	useEffect(() => {
		restoreAdminKey();
		if (adminKey.value) void loadAccounts("reset");
	}, []);

	const rows = accounts.value;
	const connected = Boolean(adminKey.value.trim());
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
		<>
			<a class="skip-link" href="#accounts-workspace">
				{tr("Skip to accounts")}
			</a>
			<header class="topbar">
				<div class="brand">
					<span class="brand-mark" aria-hidden="true">
						<Icon name="shield" size={21} />
					</span>
					<div>
						<h1>{tr("Gemini Account Pool")}</h1>
						<div class="subtitle">{tr("Account operations console")}</div>
					</div>
				</div>
				<div class="global-tools">
					<span class={`connection-pill ${connected ? "connected" : ""}`}>
						<span class="status-dot" />
						{tr(connected ? "Connected" : "Disconnected")}
					</span>
					<label class="compact-control">
						<span>
							<Icon name="globe" />
							{tr("Language")}
						</span>
						<select
							aria-label={tr("Language")}
							value={language.value}
							onChange={(event) =>
								setLanguage(
									(event.currentTarget as HTMLSelectElement).value === "zh-CN"
										? "zh-CN"
										: "en",
								)
							}
						>
							<option value="en">English</option>
							<option value="zh-CN">简体中文</option>
						</select>
					</label>
					<label class="compact-control">
						<span>
							<Icon name={themePreference.value === "dark" ? "moon" : "sun"} />
							{tr("Theme")}
						</span>
						<select
							aria-label={tr("Theme")}
							value={themePreference.value}
							onChange={(event) =>
								setThemePreference(
									(event.currentTarget as HTMLSelectElement).value as
										| "light"
										| "dark"
										| "system",
								)
							}
						>
							<option value="system">{tr("System")}</option>
							<option value="light">{tr("Light")}</option>
							<option value="dark">{tr("Dark")}</option>
						</select>
					</label>
				</div>
			</header>

			<main class="shell">
				<section
					class={`panel auth-panel ${connected ? "compact" : "hero-panel"}`}
				>
					<div class="auth-copy">
						<span class="eyebrow">
							<Icon name="key" />
							{tr("D1-backed session management")}
						</span>
						<h2>{tr("Connect to your account pool")}</h2>
						<p>
							{tr(
								"Enter the configured ADMIN_KEY to manage sanitized account metadata.",
							)}
						</p>
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
							{tr("Admin key")}
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
							{tr("Storage")}
							<select
								value={keyStorageMode.value}
								onChange={(event) => {
									keyStorageMode.value =
										(event.currentTarget as HTMLSelectElement).value === "local"
											? "local"
											: "session";
								}}
							>
								<option value="session">{tr("Session")}</option>
								<option value="local">{tr("Local")}</option>
							</select>
						</label>
						<button class="primary" type="submit" disabled={loading.value}>
							<Icon name="key" />
							{loading.value ? tr("Connecting") : tr("Connect")}
						</button>
						<button type="button" onClick={clearAdminKey}>
							{tr("Clear")}
						</button>
					</form>
					<p class="security-note">
						<Icon name="shield" />
						{tr(
							"Stored only in this browser. Public API keys cannot access admin routes.",
						)}
					</p>
				</section>

				<section class="section-block" aria-labelledby="overview-title">
					<div class="section-heading">
						<div>
							<span class="eyebrow">{tr("Overview")}</span>
							<h2 id="overview-title">{tr("Gemini Account Pool")}</h2>
						</div>
						<button
							class="secondary"
							type="button"
							aria-expanded={importExpanded.value}
							aria-controls="import-panel"
							onClick={() => {
								importExpanded.value = !importExpanded.value;
							}}
						>
							<Icon name="plus" />
							{tr("Import accounts")}
							<Icon name="chevron" />
						</button>
					</div>
					<MetricCards />
				</section>

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
								<button
									class="primary"
									type="submit"
									disabled={importBusy.value}
								>
									{importBusy.value ? tr("Importing") : tr("Import")}
								</button>
								<button type="button" onClick={resetImport}>
									{tr("Reset")}
								</button>
							</div>
						</form>
					</div>
				</section>

				<section
					id="accounts-workspace"
					class="panel workspace"
					aria-labelledby="accounts-title"
				>
					<div class="panel-head workspace-head">
						<div>
							<span class="eyebrow">{tr("Account workspace")}</span>
							<h2 id="accounts-title" class="panel-title">
								{tr("Account workspace")}
							</h2>
							<p>
								{tr(
									"Search, filter, inspect, and operate on sanitized account metadata.",
								)}
							</p>
						</div>
						<div class="actions">
							<button type="button" onClick={() => void loadAccounts("reset")}>
								<Icon name="refresh" />
								{tr("Refresh")}
							</button>
							<button type="button" onClick={exportMetadata}>
								<Icon name="download" />
								{tr("Export CSV")}
							</button>
						</div>
					</div>
					<fieldset class="filters">
						<legend class="sr-only">{tr("Search")}</legend>
						<label class="search-field">
							<span>{tr("Search")}</span>
							<div class="input-with-icon">
								<Icon name="search" />
								<input
									placeholder={tr("Label, ID, source, status")}
									value={query.value}
									onInput={(event) => {
										query.value = (
											event.currentTarget as HTMLInputElement
										).value;
									}}
								/>
							</div>
						</label>
						<label>
							{tr("Status")}
							<select
								value={statusFilter.value}
								onChange={(event) => {
									statusFilter.value = (
										event.currentTarget as HTMLSelectElement
									).value;
								}}
							>
								<option value="">{tr("All statuses")}</option>
								{statuses.map((status) => (
									<option key={status} value={status}>
										{statusLabel(status)}
									</option>
								))}
							</select>
						</label>
						<label>
							{tr("Enabled")}
							<select
								value={enabledFilter.value}
								onChange={(event) => {
									enabledFilter.value = (
										event.currentTarget as HTMLSelectElement
									).value;
								}}
							>
								<option value="">{tr("All")}</option>
								<option value="true">{tr("Enabled")}</option>
								<option value="false">{tr("Disabled")}</option>
							</select>
						</label>
						<label>
							{tr("Category")}
							<select
								value={categoryFilter.value}
								onChange={(event) => {
									categoryFilter.value = (
										event.currentTarget as HTMLSelectElement
									).value;
								}}
							>
								<option value="">{tr("All categories")}</option>
								{categories.map((category) => (
									<option key={category} value={category}>
										{statusLabel(category)}
									</option>
								))}
							</select>
						</label>
						<label>
							{tr("Cooldown")}
							<select
								value={cooldownFilter.value}
								onChange={(event) => {
									cooldownFilter.value = (
										event.currentTarget as HTMLSelectElement
									).value;
								}}
							>
								<option value="">{tr("All")}</option>
								<option value="active">{tr("Not cooling")}</option>
								<option value="cooling">{tr("Cooling")}</option>
							</select>
						</label>
						<label>
							{tr("Source")}
							<input
								value={sourceFilter.value}
								onInput={(event) => {
									sourceFilter.value = (
										event.currentTarget as HTMLInputElement
									).value;
								}}
							/>
						</label>
						<button
							class="primary filter-submit"
							type="button"
							onClick={() => void loadAccounts("reset")}
						>
							{tr("Apply")}
						</button>
					</fieldset>

					<div class="bulkbar" role="toolbar" aria-label={tr("Selected")}>
						<div>
							<strong>{selected.value.size}</strong> {tr("Selected")}
						</div>
						<div class="actions">
							<button type="button" onClick={selectVisible}>
								{tr("Select visible")}
							</button>
							<button
								type="button"
								onClick={() => {
									selected.value = new Set();
								}}
							>
								{tr("Clear selection")}
							</button>
							{batchActions.map((action) => (
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
									{statusLabel(action)}
									{batchBusy.value === action ? "…" : ""}
								</button>
							))}
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
								onClick={deleteVisible}
							>
								{tr("Delete visible")}
							</button>
						</div>
					</div>

					<div class="table-wrap">
						<table>
							<caption class="sr-only">{tr("Account workspace")}</caption>
							<thead>
								<tr>
									<th>{tr("Select")}</th>
									<th>{tr("Account")}</th>
									<th>{tr("Status")}</th>
									<th>{tr("Enabled")}</th>
									<th>{tr("Session")}</th>
									<th>{tr("Category")}</th>
									<th>{tr("Used")}</th>
									<th>{tr("Refresh")}</th>
									<th>{tr("Last success")}</th>
									<th>{tr("Last failure")}</th>
									<th>{tr("Outcome")}</th>
									<th>{tr("Cooldown")}</th>
									<th>{tr("Errors")}</th>
									<th>{tr("Source")}</th>
									<th>{tr("Actions")}</th>
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
							{tr("Previous")}
						</button>
						<span>
							{language.value === "zh-CN"
								? `第 ${pageIndex.value + 1} 页 · 已加载 ${accounts.value.length} 个${nextCursor.value ? "" : " · 已到底"}`
								: `Page ${pageIndex.value + 1} · ${accounts.value.length} loaded${nextCursor.value ? "" : " · end"}`}
						</span>
						<button
							type="button"
							disabled={loading.value || !nextCursor.value}
							onClick={() => void loadAccounts("next")}
						>
							{tr("Next")}
						</button>
					</div>
				</section>

				{lastDiagnostics.value ? (
					<section class="panel diagnostics">
						<button
							class="diagnostics-toggle"
							type="button"
							aria-expanded={diagnosticsExpanded.value}
							onClick={() => {
								diagnosticsExpanded.value = !diagnosticsExpanded.value;
							}}
						>
							<span>
								<strong>{tr("Diagnostics")}</strong>
								<small>{tr("Latest sanitized mutation summary")}</small>
							</span>
							<Icon name="chevron" />
						</button>
						{diagnosticsExpanded.value ? (
							<div class="panel-body">
								<code>
									{resultSummary("last action", lastDiagnostics.value)}
								</code>
							</div>
						) : null}
					</section>
				) : null}
			</main>
			<EditModal />
			<ConfirmationModal />
			<div class="toast" aria-live="polite" aria-atomic="true">
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
		</>
	);
}
