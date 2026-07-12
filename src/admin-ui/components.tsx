import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "./icons";
import { language, statusLabel, tr } from "./i18n";
import {
	openEdit,
	resolveConfirmation,
	runAction,
	submitEdit,
} from "./actions";
import {
	accountBusyLabel,
	accountDisplayName,
	destructiveConfirmationText,
	formatTime,
	identifier,
	identifierKey,
	isCooling,
	isRefreshable,
	relativeTime,
	safeNumber,
	sessionLabel,
} from "./logic";
import {
	accountStats,
	accounts,
	confirmationDraft,
	editBusy,
	editDraft,
	loading,
	rowBusy,
	selected,
	statuses,
} from "./state";
import type { GeminiAccount } from "./types";

const skeletonRows = ["one", "two", "three", "four", "five", "six"] as const;
const skeletonCells = [
	"select",
	"account",
	"status",
	"enabled",
	"session",
	"category",
	"used",
	"refresh",
	"success",
	"failure",
	"outcome",
	"cooldown",
	"errors",
	"source",
	"actions",
] as const;

export function MetricCards(): JSX.Element {
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
	const primaryCards: Array<{
		label: Parameters<typeof tr>[0];
		value: string | number;
		tone: string;
	}> = [
		{ label: "Total", value: total, tone: "neutral" },
		{ label: "Available", value: active, tone: "success" },
		{ label: "Needs attention", value: attention, tone: "warning" },
		{
			label: "Success / fail",
			value: `${successes} / ${failures}`,
			tone: "info",
		},
	];
	const secondaryCards: Array<{
		label: Parameters<typeof tr>[0];
		value: string | number;
	}> = [
		{ label: "Disabled", value: disabled },
		{ label: "Refreshable", value: refreshable },
		{ label: "Cooling", value: cooling },
		{ label: "PSID only", value: psidOnly },
		{ label: "Selected", value: selected.value.size },
	];
	return (
		<div class="metrics">
			<section class="primary-metrics" aria-label={tr("Primary metrics")}>
				{primaryCards.map((card) => (
					<div
						class={`metric metric-primary tone-${card.tone}`}
						key={card.label}
					>
						<div class="label">{tr(card.label)}</div>
						<div class="value">{card.value}</div>
					</div>
				))}
			</section>
			<section class="secondary-metrics" aria-label={tr("Operational metrics")}>
				{secondaryCards.map((card) => (
					<div class="metric metric-secondary" key={card.label}>
						<div class="label">{tr(card.label)}</div>
						<div class="value">{card.value}</div>
					</div>
				))}
			</section>
		</div>
	);
}

function toggleSelected(account: GeminiAccount, checked: boolean): void {
	const key = identifierKey(account);
	const next = new Set(selected.value);
	if (checked) next.add(key);
	else next.delete(key);
	selected.value = next;
}

function AccountActions({ account }: { account: GeminiAccount }): JSX.Element {
	const key = identifierKey(account);
	const enabled = Number(account.enabled) === 1;
	const busy = rowBusy.value[key] || "";
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

export function AccountRows(): JSX.Element {
	const rows = accounts.value;
	if (loading.value)
		return (
			<>
				{skeletonRows.map((rowName) => (
					<tr class="skeleton-row" key={`skeleton-${rowName}`}>
						{skeletonCells.map((cellName) => (
							<td key={`skeleton-${rowName}-${cellName}`}>
								<span class="skeleton-line" />
							</td>
						))}
					</tr>
				))}
			</>
		);
	if (!rows.length)
		return (
			<tr>
				<td class="empty" colSpan={15}>
					{tr("No accounts found")}.{" "}
					{tr("Connect with an admin key or adjust the current filters.")}
				</td>
			</tr>
		);
	return (
		<>
			{rows.map((account) => {
				const key = identifierKey(account);
				const enabled = Number(account.enabled) === 1;
				const refresh = refreshSummary(account);
				return (
					<tr data-key={key} key={key} aria-busy={!!rowBusy.value[key]}>
						<td>
							<input
								type="checkbox"
								aria-label={`Select ${accountDisplayName(account)}`}
								checked={selected.value.has(key)}
								onChange={(event) =>
									toggleSelected(
										account,
										(event.currentTarget as HTMLInputElement).checked,
									)
								}
							/>
						</td>
						<td>{accountIdentity(account)}</td>
						<td>
							<span class={`badge status-${account.status}`}>
								{statusLabel(account.status)}
							</span>
						</td>
						<td>
							<span class="badge">{enabled ? "enabled" : "disabled"}</span>
						</td>
						<td>
							<span class="badge">{sessionLabel(account)}</span>
						</td>
						<td>
							<span class="badge">
								{account.account_category
									? statusLabel(account.account_category)
									: "-"}
							</span>
						</td>
						<td>{timeCell(account.last_used_at_ms)}</td>
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
						<td>{timeCell(account.cooldown_until_ms, isCooling(account))}</td>
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
							<AccountActions account={account} />
						</td>
					</tr>
				);
			})}
		</>
	);
}

export function AccountCards(): JSX.Element {
	if (loading.value)
		return (
			<div class="card-state" role="status">
				{tr("Loading accounts")}…
			</div>
		);
	if (!accounts.value.length)
		return (
			<div class="card-state">
				{tr("No accounts found")}.{" "}
				{tr("Connect with an admin key or adjust the current filters.")}
			</div>
		);
	return (
		<div class="account-cards">
			{accounts.value.map((account) => {
				const key = identifierKey(account);
				const enabled = Number(account.enabled) === 1;
				return (
					<article
						class="account-card"
						key={key}
						aria-busy={!!rowBusy.value[key]}
					>
						<div class="account-card-head">
							<label class="account-select">
								<input
									type="checkbox"
									checked={selected.value.has(key)}
									onChange={(event) =>
										toggleSelected(
											account,
											(event.currentTarget as HTMLInputElement).checked,
										)
									}
								/>
								<span class="sr-only">
									Select {accountDisplayName(account)}
								</span>
							</label>
							{accountIdentity(account)}
						</div>
						<div class="account-card-badges">
							<span class={`badge status-${account.status}`}>
								{statusLabel(account.status)}
							</span>
							<span class="badge">{enabled ? "enabled" : "disabled"}</span>
							<span class="badge">{sessionLabel(account)}</span>
						</div>
						<dl class="account-facts">
							<div>
								<dt>{tr("Category")}</dt>
								<dd>
									{account.account_category
										? statusLabel(account.account_category)
										: "-"}
								</dd>
							</div>
							<div>
								<dt>{tr("Last used")}</dt>
								<dd>{relativeTime(account.last_used_at_ms)}</dd>
							</div>
							<div>
								<dt>{tr("Outcome")}</dt>
								<dd>
									{safeNumber(account.success_count)} /{" "}
									{safeNumber(account.failure_count)}
								</dd>
							</div>
							<div>
								<dt>{tr("Cooldown")}</dt>
								<dd>
									{isCooling(account)
										? relativeTime(account.cooldown_until_ms)
										: "-"}
								</dd>
							</div>
						</dl>
						<details class="account-details">
							<summary>{tr("More account details")}</summary>
							<dl class="account-facts secondary">
								<div>
									<dt>{tr("Refresh")}</dt>
									<dd>{refreshSummary(account)}</dd>
								</div>
								<div>
									<dt>{tr("Last success")}</dt>
									<dd>{formatTime(account.last_success_at_ms)}</dd>
								</div>
								<div>
									<dt>{tr("Last failure")}</dt>
									<dd>{formatTime(account.last_failure_at_ms)}</dd>
								</div>
								<div>
									<dt>{tr("Source")}</dt>
									<dd>
										{account.source_name ||
											account.source_id ||
											account.source ||
											"-"}
									</dd>
								</div>
								<div class="wide">
									<dt>{tr("Last error")}</dt>
									<dd>
										{account.last_error_message_redacted ||
											account.last_error_code ||
											"-"}
									</dd>
								</div>
							</dl>
						</details>
						<AccountActions account={account} />
					</article>
				);
			})}
		</div>
	);
}

function accountIdentity(account: GeminiAccount): JSX.Element {
	return (
		<div class="row-main">
			<div class="row-title">{accountDisplayName(account)}</div>
			<div class="row-sub">{account.id}</div>
			<div class="row-sub">{account.row_id}</div>
		</div>
	);
}

function refreshSummary(account: GeminiAccount): string {
	return (
		[
			account.last_refresh_at_ms
				? `ok ${relativeTime(account.last_refresh_at_ms)}`
				: "",
			account.last_refresh_attempt_at_ms
				? `try ${relativeTime(account.last_refresh_attempt_at_ms)}`
				: "",
		]
			.filter(Boolean)
			.join(" / ") || "-"
	);
}

function timeCell(value: number | null, showRelative = true): JSX.Element {
	return (
		<div class="row-main">
			<div class="row-sub nowrap">
				{showRelative ? relativeTime(value) : "-"}
			</div>
			<div class="row-sub nowrap">{formatTime(value)}</div>
		</div>
	);
}

type DialogSurfaceProps = {
	labelledBy: string;
	describedBy?: string;
	onClose: () => void;
	children: JSX.Element | JSX.Element[];
};

function DialogSurface({
	labelledBy,
	describedBy,
	onClose,
	children,
}: DialogSurfaceProps): JSX.Element {
	const dialogRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	useEffect(() => {
		const previous =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const dialog = dialogRef.current;
		const focusable = dialog ? dialogFocusable(dialog) : [];
		const initial =
			dialog?.querySelector<HTMLElement>("[data-dialog-initial]") ||
			focusable[0];
		initial?.focus();
		const handleKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab" || !dialog) return;
			const items = dialogFocusable(dialog);
			if (!items.length) return;
			const first = items[0];
			const last = items[items.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			previous?.focus();
		};
	}, []);
	return (
		<div class="modal open" aria-hidden="false">
			<div
				ref={dialogRef}
				class="dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby={labelledBy}
				aria-describedby={describedBy}
			>
				{children}
			</div>
		</div>
	);
}

function dialogFocusable(dialog: HTMLElement): HTMLElement[] {
	return [
		...dialog.querySelectorAll<HTMLElement>(
			"button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
		),
	].filter((item) => !item.hasAttribute("hidden"));
}

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
