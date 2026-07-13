import type { JSX } from "preact";
import { clearAdminKey, loadAccounts, saveAdminKey } from "../actions";
import { Icon } from "../icons";
import { tr } from "../i18n";
import {
	adminKey,
	authExpanded,
	connectionVerified,
	keyStorageMode,
	loading,
} from "../state";

export function AuthPanel(): JSX.Element {
	const connected = connectionVerified.value;
	return (
		<section
			class={`panel auth-panel ${connected ? "compact" : "hero-panel"}${authExpanded.value ? " expanded" : ""}`}
		>
			<div class="auth-copy">
				<span class="eyebrow">
					<Icon name="key" />
					{tr("D1-backed session management")}
				</span>
				<h2>
					{tr(
						connected
							? "Connected to account pool"
							: "Connect to your account pool",
					)}
				</h2>
				<p>
					{tr(
						connected
							? "Admin access is ready. Reopen settings only when credentials need to change."
							: "Enter the configured ADMIN_KEY to manage sanitized account metadata.",
					)}
				</p>
			</div>
			{connected ? (
				<button
					class="secondary auth-toggle"
					type="button"
					aria-expanded={authExpanded.value}
					onClick={() => {
						authExpanded.value = !authExpanded.value;
					}}
				>
					{tr(
						authExpanded.value
							? "Hide connection settings"
							: "Connection settings",
					)}
					<Icon name="chevron" />
				</button>
			) : null}
			{!connected || authExpanded.value ? (
				<form
					class={`auth${connected ? " auth-wide" : ""}`}
					onSubmit={(event) => {
						event.preventDefault();
						saveAdminKey();
						void loadAccounts("reset", true);
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
								connectionVerified.value = false;
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
			) : null}
			{!connected || authExpanded.value ? (
				<p class="security-note">
					<Icon name="shield" />
					{tr(
						"Stored only in this browser. Public API keys cannot access admin routes.",
					)}
				</p>
			) : null}
		</section>
	);
}
