import { signal } from "@preact/signals";

export type ThemePreference = "light" | "dark" | "system";
type ResolvedTheme = Exclude<ThemePreference, "system">;

const THEME_STORAGE_KEY = "web2gem_admin_theme";
const darkQuery = "(prefers-color-scheme: dark)";

export const themePreference = signal<ThemePreference>("system");

export function resolveTheme(
	preference: ThemePreference,
	prefersDark: boolean,
): ResolvedTheme {
	return preference === "system"
		? prefersDark
			? "dark"
			: "light"
		: preference;
}

export function initializeTheme(): () => void {
	const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
	themePreference.value = isThemePreference(stored) ? stored : "system";
	const media = window.matchMedia(darkQuery);
	const sync = (): void => applyTheme(themePreference.value, media.matches);
	sync();
	media.addEventListener("change", sync);
	return () => media.removeEventListener("change", sync);
}

export function setThemePreference(preference: ThemePreference): void {
	themePreference.value = preference;
	window.localStorage.setItem(THEME_STORAGE_KEY, preference);
	applyTheme(preference, window.matchMedia(darkQuery).matches);
}

function applyTheme(preference: ThemePreference, prefersDark: boolean): void {
	document.documentElement.dataset.theme = resolveTheme(
		preference,
		prefersDark,
	);
	document.documentElement.style.colorScheme = resolveTheme(
		preference,
		prefersDark,
	);
}

function isThemePreference(value: string | null): value is ThemePreference {
	return value === "light" || value === "dark" || value === "system";
}
