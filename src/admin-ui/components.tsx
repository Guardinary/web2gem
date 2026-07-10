import type { JSX } from "preact";
import { openEdit, runAction, submitEdit } from "./actions";
import {
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
	actionBusy,
	accounts,
	editDraft,
	loading,
	selected,
	statuses,
} from "./state";

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

export function AccountRows(): JSX.Element {
	const rows = accounts.value;
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

export function EditModal(): JSX.Element | null {
	const draft = editDraft.value;
	if (!draft) return null;
	const update = (field: keyof typeof draft) => (event: Event) => {
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
