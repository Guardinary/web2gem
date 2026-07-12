import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { errorLine, outputLine } from "./io.mjs";

const bundlePath = process.argv[2] || "dist/worker.js";
const defaultLimitBytes = 3 * 1024 * 1024;
const limitBytes = parseLimit(
	process.env.BUNDLE_GZIP_SIZE_LIMIT_BYTES,
	defaultLimitBytes,
);

try {
	const bundle = await readFile(bundlePath);
	if (bundle.length <= 0) {
		fail(`${bundlePath} is missing or empty`);
	}
	const gzipBytes = gzipSync(bundle, { level: 9 }).length;
	if (gzipBytes > limitBytes) {
		fail(
			`${bundlePath} gzip size is ${formatBytes(gzipBytes)}, limit ${formatBytes(limitBytes)}`,
		);
	}
	outputLine(
		`bundle size ok: ${bundlePath} raw ${formatBytes(bundle.length)}, gzip ${formatBytes(gzipBytes)} <= ${formatBytes(limitBytes)}, headroom ${formatBytes(limitBytes - gzipBytes)}`,
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
