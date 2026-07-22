import type { WorkerEnv } from "./types";

export class RuntimeConfigError extends Error {
	readonly code = "invalid_runtime_config";

	constructor(
		readonly setting: string,
		readonly reason: string,
	) {
		super(`invalid runtime configuration: ${setting} ${reason}`);
		this.name = "RuntimeConfigError";
	}
}

export function configValue(
	env: WorkerEnv,
	key: keyof WorkerBindings,
	fallback: unknown,
): unknown {
	const value = env[key];
	return value === undefined || value === null || value === ""
		? fallback
		: value;
}

export function parseStrictBoolean(setting: string, value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new RuntimeConfigError(setting, "must be true or false");
}

export function parseString(setting: string, value: unknown): string {
	if (typeof value !== "string")
		throw new RuntimeConfigError(setting, "must be a string");
	return value;
}

export function parseStrictInteger(
	setting: string,
	value: unknown,
	min: number,
	max: number,
): number {
	let parsed: number;
	if (typeof value === "number") {
		parsed = value;
	} else if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
		parsed = Number(value);
	} else {
		throw new RuntimeConfigError(
			setting,
			`must be an integer between ${min} and ${max}`,
		);
	}
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new RuntimeConfigError(
			setting,
			`must be an integer between ${min} and ${max}`,
		);
	}
	return parsed;
}

export function parseZeroOrBoundedInteger(
	setting: string,
	value: unknown,
	min: number,
	max: number,
): number {
	if (value === 0 || value === "0") return 0;
	return parseStrictInteger(setting, value, min, max);
}

export function parseCapabilityMode(
	setting: string,
	value: unknown,
): "off" | "prefer" | "strict" {
	if (value === "off" || value === "prefer" || value === "strict") return value;
	throw new RuntimeConfigError(setting, "must be off, prefer, or strict");
}

export function parseNonEmptyString(
	setting: string,
	value: unknown,
	maxLength: number,
): string {
	if (typeof value !== "string")
		throw new RuntimeConfigError(setting, "must be a string");
	const parsed = value.trim();
	if (!parsed) throw new RuntimeConfigError(setting, "must not be empty");
	if (parsed.length > maxLength)
		throw new RuntimeConfigError(
			setting,
			`must be at most ${maxLength} characters`,
		);
	return parsed;
}

export function parseHttpOrigin(setting: string, value: unknown): string {
	const raw = parseNonEmptyString(setting, value, 2048);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch (_) {
		throw new RuntimeConfigError(setting, "must be an absolute HTTP(S) origin");
	}
	if (
		(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash
	) {
		throw new RuntimeConfigError(setting, "must be an absolute HTTP(S) origin");
	}
	return parsed.origin;
}

export function parseKeyList(setting: string, value: unknown): string[] {
	let items: unknown[];
	if (Array.isArray(value)) {
		items = value;
	} else if (typeof value === "string") {
		const raw = value.trim();
		if (!raw) return [];
		if (raw.startsWith("[")) {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (!Array.isArray(parsed))
					throw new RuntimeConfigError(
						setting,
						"must be a comma-separated list or JSON array",
					);
				items = parsed;
			} catch (error) {
				if (error instanceof RuntimeConfigError) throw error;
				throw new RuntimeConfigError(
					setting,
					"must be a comma-separated list or valid JSON array",
				);
			}
		} else {
			items = raw.split(",");
		}
	} else {
		throw new RuntimeConfigError(
			setting,
			"must be a comma-separated list or JSON array",
		);
	}
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (typeof item !== "string")
			throw new RuntimeConfigError(setting, "must contain only strings");
		const key = item.trim();
		if (!key)
			throw new RuntimeConfigError(setting, "must not contain empty entries");
		if (key.length > 4096)
			throw new RuntimeConfigError(
				setting,
				"contains an entry longer than 4096 characters",
			);
		if (seen.has(key))
			throw new RuntimeConfigError(
				setting,
				"must not contain duplicate entries",
			);
		seen.add(key);
		out.push(key);
	}
	return out;
}
