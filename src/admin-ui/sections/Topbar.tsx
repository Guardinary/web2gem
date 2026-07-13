import type { JSX } from "preact";
import { Icon } from "../icons";
import { language, setLanguage, tr } from "../i18n";
import { connectionVerified } from "../state";
import { setThemePreference, themePreference } from "../theme";

export function Topbar(): JSX.Element {
	const connected = connectionVerified.value;
	return (
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
	);
}
