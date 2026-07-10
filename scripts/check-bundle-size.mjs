import { stat } from "node:fs/promises";
import { errorLine, outputLine } from "./io.mjs";

const bundlePath = process.argv[2] || "dist/worker.js";
const defaultLimitBytes = 1024 * 1024;
const limitBytes = parseLimit(
	process.env.BUNDLE_SIZE_LIMIT_BYTES,
	defaultLimitBytes,
);

try {
	const stats = await stat(bundlePath);
	if (!stats.isFile() || stats.size <= 0) {
		fail(`${bundlePath} is missing or empty`);
	}
	if (stats.size > limitBytes) {
		fail(
			`${bundlePath} is ${formatBytes(stats.size)}, limit ${formatBytes(limitBytes)}`,
		);
	}
	outputLine(
		`bundle size ok: ${bundlePath} ${formatBytes(stats.size)} <= ${formatBytes(limitBytes)}`,
	);
} catch (error) {
	if (
		error &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "ENOENT"
	) {
		fail(`${bundlePath} does not exist; run pnpm build first`);
	}
	throw error;
}

function parseLimit(value, fallback) {
	if (value == null || value === "") return fallback;
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function formatBytes(bytes) {
	return `${bytes} bytes`;
}

function fail(message) {
	errorLine(`Bundle size gate failed: ${message}`);
	process.exit(1);
}
