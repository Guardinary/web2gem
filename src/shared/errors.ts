import type { ErrorWithMetadata } from "./types";

export function upstreamErrorMessage(error: unknown): string {
	const candidate = error as { message?: unknown } | null | undefined;
	return String(candidate?.message || error);
}

export function upstreamErrorCode(error: unknown): string | undefined {
	const candidate = error as Partial<ErrorWithMetadata> | null | undefined;
	return candidate && typeof candidate.code === "string"
		? candidate.code
		: undefined;
}

export function upstreamErrorStatus(error: unknown): number | undefined {
	const candidate = error as Partial<ErrorWithMetadata> | null | undefined;
	const status = Number(candidate?.status);
	return Number.isInteger(status) && status >= 400 && status <= 599
		? status
		: undefined;
}

export function errorLogSummary(error: unknown): string {
	const candidate = error as Partial<ErrorWithMetadata> | null | undefined;
	const parts = [
		`type=${candidate && typeof candidate.name === "string" && candidate.name ? candidate.name : typeof error}`,
	];
	const code = upstreamErrorCode(error);
	if (code) parts.push(`code=${code}`);
	const status = upstreamErrorStatus(error);
	if (status) parts.push(`status=${status}`);
	const upstreamStatus = Number(candidate?.upstreamStatus);
	if (
		Number.isInteger(upstreamStatus) &&
		upstreamStatus >= 100 &&
		upstreamStatus <= 599
	)
		parts.push(`upstreamStatus=${upstreamStatus}`);
	const rawLength = Number(candidate?.rawLength);
	if (Number.isInteger(rawLength) && rawLength >= 0)
		parts.push(`rawLength=${rawLength}`);
	return parts.join(" ");
}

export function canFallbackAfterSocketError(
	_method: string,
	error: unknown,
): boolean {
	return !(
		error &&
		typeof error === "object" &&
		(error as Partial<ErrorWithMetadata>).upstreamStatus
	);
}
