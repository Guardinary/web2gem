type LogConfig = { log_requests?: unknown } | null | undefined;

function formatLogMessage(msg: unknown): string {
	if (msg instanceof Error) return msg.stack || msg.message;
	if (typeof msg === "string") return msg;
	if (msg === null || msg === undefined) return String(msg);
	if (typeof msg === "object") {
		try {
			return JSON.stringify(msg);
		} catch (_) {}
	}
	return String(msg);
}

function writeLog(msg: unknown): void {
	try {
		const consoleValue = Reflect.get(globalThis, "console") as
			| { log?: (message: unknown) => void }
			| undefined;
		consoleValue?.log?.(`[web2gem] ${formatLogMessage(msg)}`);
	} catch (_) {}
}

export function log(cfg: LogConfig, msg: unknown): void {
	if (cfg?.log_requests) writeLog(msg);
}

export function nowMs(): number {
	return performance.now();
}

export function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

export function elapsedMs(startMs: number): number {
	return Math.max(0, Math.round((nowMs() - startMs) * 10) / 10);
}

export function logStage(
	cfg: LogConfig,
	stage: string,
	fields: Record<string, unknown> = {},
): void {
	if (!cfg?.log_requests) return;
	const parts = [`stage=${stage}`];
	for (const [key, value] of Object.entries(fields)) {
		if (value == null || value === "") continue;
		parts.push(`${key}=${String(value)}`);
	}
	log(cfg, parts.join(" "));
}
