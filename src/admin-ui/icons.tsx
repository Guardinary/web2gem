import type { JSX } from "preact";

export type IconName =
	| "alert"
	| "check"
	| "chevron"
	| "download"
	| "edit"
	| "globe"
	| "key"
	| "moon"
	| "plus"
	| "refresh"
	| "search"
	| "shield"
	| "sun"
	| "trash";

const paths: Record<IconName, JSX.Element> = {
	alert: (
		<>
			<path d="M12 3 2.8 20h18.4Z" />
			<path d="M12 9v4M12 17h.01" />
		</>
	),
	check: <path d="m5 12 4 4L19 6" />,
	chevron: <path d="m8 10 4 4 4-4" />,
	download: (
		<>
			<path d="M12 3v12" />
			<path d="m7 10 5 5 5-5" />
			<path d="M5 21h14" />
		</>
	),
	edit: (
		<>
			<path d="M12 20h9" />
			<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
		</>
	),
	globe: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
		</>
	),
	key: (
		<>
			<circle cx="8" cy="15" r="4" />
			<path d="m11 12 9-9M17 6l3 3M14 9l3 3" />
		</>
	),
	moon: <path d="M20 15.5A9 9 0 0 1 8.5 4 9 9 0 1 0 20 15.5Z" />,
	plus: <path d="M12 5v14M5 12h14" />,
	refresh: (
		<>
			<path d="M20 7v5h-5" />
			<path d="M4 17v-5h5" />
			<path d="M6.1 9A7 7 0 0 1 18 6l2 6M18 15a7 7 0 0 1-12 3l-2-6" />
		</>
	),
	search: (
		<>
			<circle cx="11" cy="11" r="7" />
			<path d="m20 20-4-4" />
		</>
	),
	shield: (
		<>
			<path d="M12 3 4.5 6v5.5c0 4.6 3.2 7.7 7.5 9.5 4.3-1.8 7.5-4.9 7.5-9.5V6Z" />
			<path d="m9 12 2 2 4-4" />
		</>
	),
	sun: (
		<>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
		</>
	),
	trash: (
		<>
			<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />
		</>
	),
};

export function Icon({
	name,
	size = 18,
}: {
	name: IconName;
	size?: number;
}): JSX.Element {
	return (
		<svg
			aria-hidden="true"
			class="icon"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			{paths[name]}
		</svg>
	);
}
