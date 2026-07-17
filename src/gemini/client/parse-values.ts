export function getNested(
	value: unknown,
	path: readonly (number | string)[],
): unknown {
	let cur = value;
	for (const key of path) {
		if (Array.isArray(cur) && typeof key === "number") {
			cur = cur[key];
			continue;
		}
		if (isObjectLike(cur) && typeof key === "string") {
			cur = cur[key];
			continue;
		}
		return undefined;
	}
	return cur;
}

export function stringAt(value: unknown): string {
	return typeof value === "string" && value.trim() ? value : "";
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
