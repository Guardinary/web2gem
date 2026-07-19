export function capabilityFreshAfterMs(
	ttlSeconds: unknown,
	nowMs: number,
): number {
	return nowMs - Math.max(Number(ttlSeconds) || 3600, 60) * 1000;
}
