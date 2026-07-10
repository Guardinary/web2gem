import { signal } from "@preact/signals";
import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import {
	createAccount,
	createAccounts,
	getAccountStats,
	listAccounts,
	runAccountAction,
	updateAccount,
} from "./api";
import type {
	AccountIdentifier,
	AccountStats,
	GeminiAccount,
	MutationResult,
} from "./types";

const KEY_STORAGE = "web2gem_gemini_admin_key";
const KEY_STORAGE_MODE = "web2gem_gemini_admin_key_storage";

const statuses = [
	"active",
	"disabled",
	"auth_failed",
	"needs_cookie_update",
	"rate_limited",
	"cooling_down",
	"transient_failed",
	"hard_blocked",
	"needs_user_action",
	"missing_cookie",
	"capability_mismatch",
] as const;

const categories = [
	"full_session",
	"psid_psidts",
	"psid_only",
	"session_token_only",
	"missing_session",
] as const;

type ToastItem = { id: number; message: string; kind?: "error" };
type EditDraft = {
	key: string;
	label: string;
	status: string;
	enabled: string;
	stateReason: string;
	source: string;
	sourceName: string;
};

const adminKey = signal("");
const accounts = signal<GeminiAccount[]>([]);
const selected = signal<Set<string>>(new Set());
const loading = signal(false);
const query = signal("");
const statusFilter = signal("");
const enabledFilter = signal("");
const categoryFilter = signal("");
const cooldownFilter = signal("");
const sourceFilter = signal("");
const cursorStack = signal<string[]>([""]);
const pageIndex = signal(0);
const nextCursor = signal<string | null>(null);
const toastItems = signal<ToastItem[]>([]);
const editDraft = signal<EditDraft | null>(null);
const importLabel = signal("");
const importPsid = signal("");
const importPsidts = signal("");
const importBatch = signal("");
const keyStorageMode = signal<"session" | "local">("session");
const accountStats = signal<AccountStats | null>(null);
const actionBusy = signal("");
const lastDiagnostics = signal<MutationResult | null>(null);

let toastId = 0;

function text(value: unknown): string {
	return String(value == null ? "" : value);
}

function identifier(account: GeminiAccount): AccountIdentifier {
	return account.id ? { id: account.id } : { row_id: account.row_id };
}

function identifierKey(account: GeminiAccount): string {
	return account.id || account.row_id;
}

function selectedIdentifiers(): AccountIdentifier[] {
	const current = selected.value;
	return accounts.value
		.filter((account) => current.has(identifierKey(account)))
		.map(identifier);
}

function formatTime(value: number | null): string {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return "-";
	try {
		return new Date(n).toLocaleString();
	} catch {
		return "-";
	}
}

function relativeTime(value: number | null): string {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return "-";
	const diff = n - Date.now();
	const abs = Math.abs(diff);
	let unit = "m";
	let amount = Math.round(abs / 60000);
	if (abs >= 86400000) {
		unit = "d";
		amount = Math.round(abs / 86400000);
	} else if (abs >= 3600000) {
		unit = "h";
		amount = Math.round(abs / 3600000);
	}
	if (amount < 1) amount = 1;
	return diff >= 0 ? `in ${amount}${unit}` : `${amount}${unit} ago`;
}

function safeNumber(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function isCooling(account: GeminiAccount): boolean {
	return Number(account.cooldown_until_ms) > Date.now();
}

function isRefreshable(account: GeminiAccount): boolean {
	return (
		["full_session", "psid_psidts"].includes(text(account.account_category)) &&
		Number(account.enabled) === 1
	);
}

function sessionLabel(account: GeminiAccount): string {
	return (
		[
			account.has_cookie ? "cookie" : "",
			account.has_sapisid ? "sapisid" : "",
			account.has_session_token ? "token" : "",
		]
			.filter(Boolean)
			.join(" / ") || "missing"
	);
}

function showToast(message: string, kind?: "error"): void {
	const id = ++toastId;
	const item: ToastItem = kind ? { id, message, kind } : { id, message };
	toastItems.value = [...toastItems.value, item];
	window.setTimeout(() => {
		toastItems.value = toastItems.value.filter((toast) => toast.id !== id);
	}, 5000);
}

function resultSummary(action: string, result: MutationResult): string {
	const parts: string[] = [];
	for (const key of [
		"checked",
		"refreshed",
		"unchanged",
		"updated",
		"removed",
		"added",
		"duplicates",
		"skipped",
		"failed",
	] as const) {
		if (result[key] != null) parts.push(`${key} ${result[key]}`);
	}
	const firstError =
		result.errors?.[0]?.error || result.errors?.[0]?.message || "";
	return `${action} completed${parts.length ? `: ${parts.join(", ")}` : ""}${firstError ? ` - ${firstError}` : ""}`;
}

function validateCookieValue(value: string, name: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${name} is required`);
	if (
		normalized.includes("=") ||
		normalized.includes(";") ||
		normalized.startsWith("{") ||
		normalized.startsWith("[") ||
		/__Secure-1PSID/i.test(normalized)
	) {
		throw new Error(`${name} must be a value only`);
	}
	return normalized;
}

function visibleAccounts(): GeminiAccount[] {
	return accounts.value;
}

function csvValue(value: unknown): string {
	return `"${text(value).replace(/"/g, '""')}"`;
}

function exportMetadata(): void {
	const rows = visibleAccounts().length ? visibleAccounts() : accounts.value;
	if (!rows.length) {
		showToast("No accounts to export", "error");
		return;
	}
	const fields = [
		"id",
		"row_id",
		"label",
		"enabled",
		"status",
		"account_category",
		"state_reason",
		"last_used_at_ms",
		"last_success_at_ms",
		"last_failure_at_ms",
		"last_refresh_at_ms",
		"last_refresh_attempt_at_ms",
		"cooldown_until_ms",
		"success_count",
		"failure_count",
		"last_error_code",
		"last_error_message_redacted",
		"source",
		"source_id",
		"source_name",
	] as const;
	const csv = [
		fields.join(","),
		...rows.map((account) =>
			fields.map((field) => csvValue(account[field])).join(","),
		),
	].join("\n");
	const url = URL.createObjectURL(
		new Blob([csv], { type: "text/csv;charset=utf-8" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = "gemini-account-metadata.csv";
	link.click();
	URL.revokeObjectURL(url);
	showToast(`Exported ${rows.length} metadata rows`);
}

async function loadAccounts(
	direction: "current" | "reset" | "next" | "prev" = "current",
): Promise<void> {
	if (!adminKey.value.trim()) {
		showToast("Admin key is required", "error");
		return;
	}
	if (direction === "reset") {
		cursorStack.value = [""];
		pageIndex.value = 0;
		nextCursor.value = null;
		selected.value = new Set();
	} else if (direction === "next") {
		if (!nextCursor.value) return;
		const nextStack = [...cursorStack.value];
		nextStack[pageIndex.value + 1] = nextCursor.value;
		cursorStack.value = nextStack;
		pageIndex.value += 1;
	} else if (direction === "prev") {
		if (pageIndex.value <= 0) return;
		pageIndex.value -= 1;
	}
	loading.value = true;
	try {
		const options = {
			adminKey: adminKey.value,
			cursor: cursorStack.value[pageIndex.value] || "",
			status: statusFilter.value,
			enabled: enabledFilter.value,
			q: query.value.trim(),
			category: categoryFilter.value,
			cooldown: cooldownFilter.value,
			source: sourceFilter.value.trim(),
		};
		const [page, stats] = await Promise.all([
			listAccounts(options),
			getAccountStats(options),
		]);
		accounts.value = page.items;
		accountStats.value = stats;
		nextCursor.value = page.nextCursor;
		selected.value = new Set(
			[...selected.value].filter((key) =>
				page.items.some((account) => identifierKey(account) === key),
			),
		);
		showToast(`Loaded ${page.items.length} accounts`);
	} catch (error) {
		showToast(
			error instanceof Error ? error.message : "Failed to load accounts",
			"error",
		);
	} finally {
		loading.value = false;
	}
}

async function submitImport(event: Event): Promise<void> {
	event.preventDefault();
	try {
		actionBusy.value = "import";
		const batch = parseBatchImport();
		const result =
			batch.length > 1
				? await createAccounts(adminKey.value, { accounts: batch })
				: await createAccount(
						adminKey.value,
						batch[0] || {
							label: importLabel.value.trim(),
							psid: validateCookieValue(importPsid.value, "__Secure-1PSID"),
							psidts: validateCookieValue(
								importPsidts.value,
								"__Secure-1PSIDTS",
							),
						},
					);
		lastDiagnostics.value = result;
		showToast(
			resultSummary("import", result),
			result.failed || result.errors?.length ? "error" : undefined,
		);
		importLabel.value = "";
		importPsid.value = "";
		importPsidts.value = "";
		importBatch.value = "";
		await loadAccounts("reset");
	} catch (error) {
		showToast(
			error instanceof Error ? error.message : "Import failed",
			"error",
		);
	} finally {
		actionBusy.value = "";
	}
}

async function runAction(
	action: string,
	identifiers: AccountIdentifier[],
	targetLabel = "selected account(s)",
): Promise<void> {
	if (!identifiers.length) {
		showToast("Select at least one account", "error");
		return;
	}
	if (
		action === "delete" &&
		!window.confirm(`Delete ${identifiers.length} ${targetLabel}?`)
	)
		return;
	try {
		actionBusy.value = action;
		const result = await runAccountAction(adminKey.value, action, identifiers);
		lastDiagnostics.value = result;
		showToast(
			resultSummary(action, result),
			result.failed || result.errors?.length ? "error" : undefined,
		);
		await loadAccounts();
	} catch (error) {
		showToast(
			error instanceof Error ? error.message : `${action} failed`,
			"error",
		);
	} finally {
		actionBusy.value = "";
	}
}

async function submitEdit(event: Event): Promise<void> {
	event.preventDefault();
	const draft = editDraft.value;
	if (!draft) return;
	const account = accounts.value.find(
		(item) => identifierKey(item) === draft.key,
	);
	if (!account) {
		editDraft.value = null;
		return;
	}
	try {
		const result = await updateAccount(adminKey.value, {
			...identifier(account),
			label: draft.label.trim() || null,
			status: draft.status,
			enabled: draft.enabled === "true",
			state_reason: draft.stateReason.trim() || null,
			source: draft.source.trim() || null,
			source_name: draft.sourceName.trim() || null,
		});
		showToast(resultSummary("update", result));
		editDraft.value = null;
		await loadAccounts();
	} catch (error) {
		showToast(
			error instanceof Error ? error.message : "Update failed",
			"error",
		);
	}
}

function openEdit(account: GeminiAccount): void {
	editDraft.value = {
		key: identifierKey(account),
		label: text(account.label),
		status: account.status,
		enabled: Number(account.enabled) === 1 ? "true" : "false",
		stateReason: text(account.state_reason),
		source: text(account.source),
		sourceName: text(account.source_name),
	};
}

function parseBatchImport(): Array<{
	label?: string;
	psid: string;
	psidts: string;
}> {
	const raw = importBatch.value.trim();
	if (!raw) return [];
	const out: Array<{ label?: string; psid: string; psidts: string }> = [];
	for (const line of raw.split(/\r?\n/)) {
		const textLine = line.trim();
		if (!textLine) continue;
		const parts = textLine
			.split(/[,\t ]+/)
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length < 2) throw new Error("Batch rows require PSID and PSIDTS");
		const item = {
			psid: validateCookieValue(parts[0] || "", "__Secure-1PSID"),
			psidts: validateCookieValue(parts[1] || "", "__Secure-1PSIDTS"),
		};
		const label = parts.slice(2).join(" ").trim();
		out.push(label ? { ...item, label } : item);
	}
	if (!out.length) throw new Error("Batch import is empty");
	return out;
}

function MetricCards(): JSX.Element {
	const stats = accountStats.value;
	const total = stats?.total ?? accounts.value.length;
	const active =
		stats?.available ??
		accounts.value.filter(
			(item) => item.status === "active" && Number(item.enabled) === 1,
		).length;
	const attention =
		stats?.needsAttention ??
		accounts.value.filter((item) =>
			[
				"auth_failed",
				"needs_cookie_update",
				"rate_limited",
				"cooling_down",
				"hard_blocked",
				"needs_user_action",
				"missing_cookie",
				"capability_mismatch",
			].includes(item.status),
		).length;
	const disabled =
		stats?.disabled ??
		accounts.value.filter(
			(item) => Number(item.enabled) !== 1 || item.status === "disabled",
		).length;
	const refreshable =
		stats?.refreshable ?? accounts.value.filter(isRefreshable).length;
	const cooling = stats?.cooling ?? accounts.value.filter(isCooling).length;
	const psidOnly =
		stats?.psidOnly ??
		accounts.value.filter(
			(item) =>
				item.account_category === "psid_only" ||
				item.account_category === "missing_session",
		).length;
	const successes =
		stats?.successCount ??
		accounts.value.reduce(
			(sum, item) => sum + safeNumber(item.success_count),
			0,
		);
	const failures =
		stats?.failureCount ??
		accounts.value.reduce(
			(sum, item) => sum + safeNumber(item.failure_count),
			0,
		);
	const cards: [string, string | number][] = [
		["Total", total],
		["Available", active],
		["Needs attention", attention],
		["Disabled", disabled],
		["Refreshable", refreshable],
		["Cooling", cooling],
		["PSID only", psidOnly],
		["Success / fail", `${successes} / ${failures}`],
		["Selected", selected.value.size],
	];
	return (
		<div class="metrics">
			{cards.map(([label, value]) => (
				<div class="metric" key={label}>
					<div class="label">{label}</div>
					<div class="value">{value}</div>
				</div>
			))}
		</div>
	);
}

function AccountRows(): JSX.Element {
	const rows = visibleAccounts();
	if (loading.value)
		return (
			<tr>
				<td class="loading" colSpan={15}>
					Loading accounts...
				</td>
			</tr>
		);
	if (!rows.length)
		return (
			<tr>
				<td class="empty" colSpan={15}>
					No accounts match the current filters.
				</td>
			</tr>
		);
	return (
		<>
			{rows.map((account) => {
				const key = identifierKey(account);
				const enabled = Number(account.enabled) === 1;
				const refresh =
					[
						account.last_refresh_at_ms
							? `ok ${relativeTime(account.last_refresh_at_ms)}`
							: "",
						account.last_refresh_attempt_at_ms
							? `try ${relativeTime(account.last_refresh_attempt_at_ms)}`
							: "",
					]
						.filter(Boolean)
						.join(" / ") || "-";
				return (
					<tr data-key={key} key={key}>
						<td>
							<input
								type="checkbox"
								checked={selected.value.has(key)}
								onChange={(event) => {
									const next = new Set(selected.value);
									if ((event.currentTarget as HTMLInputElement).checked)
										next.add(key);
									else next.delete(key);
									selected.value = next;
								}}
							/>
						</td>
						<td>
							<div class="row-main">
								<div class="row-title">
									{account.label ||
										account.id ||
										account.row_id ||
										"Gemini account"}
								</div>
								<div class="row-sub">{account.id}</div>
								<div class="row-sub">{account.row_id}</div>
							</div>
						</td>
						<td>
							<span class={`badge status-${account.status}`}>
								{account.status}
							</span>
						</td>
						<td>
							<span class="badge">{enabled ? "enabled" : "disabled"}</span>
						</td>
						<td>
							<span class="badge">{sessionLabel(account)}</span>
						</td>
						<td>
							<span class="badge">{account.account_category || "-"}</span>
						</td>
						<td>
							<div class="row-main">
								<div class="row-sub nowrap">
									{relativeTime(account.last_used_at_ms)}
								</div>
								<div class="row-sub nowrap">
									{formatTime(account.last_used_at_ms)}
								</div>
							</div>
						</td>
						<td>
							<div class="row-main">
								<div class="row-sub">{refresh}</div>
								<div class="row-sub nowrap">
									{formatTime(account.last_refresh_at_ms)}
								</div>
							</div>
						</td>
						<td class="nowrap">{formatTime(account.last_success_at_ms)}</td>
						<td class="nowrap">{formatTime(account.last_failure_at_ms)}</td>
						<td>
							<span class="badge">
								{safeNumber(account.success_count)} /{" "}
								{safeNumber(account.failure_count)}
							</span>
						</td>
						<td>
							<div class="row-main">
								<div class="row-sub">
									{isCooling(account)
										? relativeTime(account.cooldown_until_ms)
										: "-"}
								</div>
								<div class="row-sub nowrap">
									{formatTime(account.cooldown_until_ms)}
								</div>
							</div>
						</td>
						<td>
							<div class="row-main">
								<div class="row-sub">{account.last_error_code || "-"}</div>
								<div class="row-sub">
									{account.last_error_message_redacted || ""}
								</div>
							</div>
						</td>
						<td>
							<div class="row-main">
								<div class="row-sub">{account.source || "-"}</div>
								<div class="row-sub">
									{account.source_name || account.source_id || ""}
								</div>
							</div>
						</td>
						<td>
							<div class="cell-actions">
								<button
									type="button"
									disabled={!!actionBusy.value}
									onClick={() => openEdit(account)}
								>
									Edit
								</button>
								<button
									type="button"
									disabled={!!actionBusy.value}
									onClick={() =>
										void runAction("refresh", [identifier(account)])
									}
								>
									Refresh
								</button>
								<button
									type="button"
									disabled={!!actionBusy.value}
									onClick={() => void runAction("check", [identifier(account)])}
								>
									Check
								</button>
								<button
									type="button"
									disabled={!!actionBusy.value}
									onClick={() =>
										void runAction(enabled ? "disable" : "enable", [
											identifier(account),
										])
									}
								>
									{enabled ? "Disable" : "Enable"}
								</button>
								<button
									type="button"
									disabled={!!actionBusy.value}
									class="danger"
									onClick={() =>
										void runAction("delete", [identifier(account)])
									}
								>
									Delete
								</button>
							</div>
						</td>
					</tr>
				);
			})}
		</>
	);
}

function EditModal(): JSX.Element | null {
	const draft = editDraft.value;
	if (!draft) return null;
	const update = (field: keyof EditDraft) => (event: Event) => {
		editDraft.value = {
			...draft,
			[field]: (event.currentTarget as HTMLInputElement | HTMLSelectElement)
				.value,
		};
	};
	return (
		<div class="modal open" aria-hidden="false">
			<div
				class="dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="edit-title"
			>
				<div class="dialog-head">
					<div>
						<div id="edit-title" class="dialog-title">
							Edit account
						</div>
						<div class="help">{draft.key}</div>
					</div>
					<button
						type="button"
						onClick={() => {
							editDraft.value = null;
						}}
					>
						Close
					</button>
				</div>
				<form
					id="edit-form"
					class="grid"
					onSubmit={(event) => void submitEdit(event)}
				>
					<label>
						Label
						<input
							value={draft.label}
							onInput={update("label")}
							placeholder="Display label"
						/>
					</label>
					<div class="field-row">
						<label>
							Status
							<select value={draft.status} onChange={update("status")}>
								{statuses.map((status) => (
									<option key={status} value={status}>
										{status}
									</option>
								))}
							</select>
						</label>
						<label>
							Enabled
							<select value={draft.enabled} onChange={update("enabled")}>
								<option value="true">Enabled</option>
								<option value="false">Disabled</option>
							</select>
						</label>
					</div>
					<label>
						State reason
						<input
							value={draft.stateReason}
							onInput={update("stateReason")}
							placeholder="Optional status note"
						/>
					</label>
					<div class="field-row">
						<label>
							Source
							<input
								value={draft.source}
								onInput={update("source")}
								placeholder="Optional source"
							/>
						</label>
						<label>
							Source name
							<input
								value={draft.sourceName}
								onInput={update("sourceName")}
								placeholder="Optional source name"
							/>
						</label>
					</div>
					<div class="actions">
						<button class="primary" type="submit">
							Save changes
						</button>
						<button
							type="button"
							onClick={() => {
								editDraft.value = null;
							}}
						>
							Cancel
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

export function App(): JSX.Element {
	useEffect(() => {
		keyStorageMode.value =
			window.localStorage.getItem(KEY_STORAGE_MODE) === "local"
				? "local"
				: "session";
		adminKey.value =
			window.sessionStorage.getItem(KEY_STORAGE) ||
			window.localStorage.getItem(KEY_STORAGE) ||
			"";
		if (adminKey.value) void loadAccounts("reset");
	}, []);

	const rows = visibleAccounts();
	const selectVisible = (): void => {
		selected.value = new Set([...selected.value, ...rows.map(identifierKey)]);
	};
	const deleteVisible = (): void => {
		void runAction("delete", rows.map(identifier), "loaded account(s)");
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
						window.sessionStorage.removeItem(KEY_STORAGE);
						window.localStorage.removeItem(KEY_STORAGE);
						window.localStorage.setItem(KEY_STORAGE_MODE, keyStorageMode.value);
						const storage =
							keyStorageMode.value === "local"
								? window.localStorage
								: window.sessionStorage;
						storage.setItem(KEY_STORAGE, adminKey.value.trim());
						showToast("Admin key saved");
						void loadAccounts("reset");
					}}
				>
					<label>
						Admin key
						<input
							type="password"
							autocomplete="current-password"
							placeholder="ADMIN_KEY or one ADMIN_KEYS value"
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
						Save
					</button>
					<button
						type="button"
						onClick={() => {
							window.sessionStorage.removeItem(KEY_STORAGE);
							window.localStorage.removeItem(KEY_STORAGE);
							adminKey.value = "";
							accounts.value = [];
							accountStats.value = null;
							selected.value = new Set();
							showToast("Admin key cleared");
						}}
					>
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
										disabled={!!actionBusy.value}
									>
										{actionBusy.value === "import" ? "Importing" : "Import"}
									</button>
									<button
										type="button"
										onClick={() => {
											importLabel.value = "";
											importPsid.value = "";
											importPsidts.value = "";
											importBatch.value = "";
										}}
									>
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
										disabled={!!actionBusy.value}
										key={action}
										onClick={() =>
											void runAction(action, selectedIdentifiers())
										}
									>
										{actionBusy.value === action
											? "Working"
											: action.slice(0, 1).toUpperCase() + action.slice(1)}
									</button>
								))}
								<button
									type="button"
									disabled={!!actionBusy.value}
									class="danger"
									onClick={() =>
										void runAction("delete", selectedIdentifiers())
									}
								>
									Delete
								</button>
								<button
									type="button"
									disabled={!!actionBusy.value}
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
								Actions use account identifiers from the sanitized admin API
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
			<div class="toast" aria-live="polite" aria-atomic="true">
				{toastItems.value.map((item) => (
					<div
						key={item.id}
						class={`toast-item${item.kind === "error" ? " error" : ""}`}
					>
						{item.message}
					</div>
				))}
			</div>
		</main>
	);
}
