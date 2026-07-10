import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { errorLine, outputLine } from "./io.mjs";

const DEFAULT_CASE = "stream_sieve_held_tool";
const DEFAULT_MAX_MEDIAN_MS = 20;
const DEFAULT_ITERS = "80";
const DEFAULT_WARMUP = "10";

const outputPath = process.argv[2] || "";
const caseName =
	String(process.env.BENCH_GATE_CASE || DEFAULT_CASE).trim() || DEFAULT_CASE;
const maxMedianMs = positiveNumber(
	process.env.BENCH_MAX_MEDIAN_MS,
	DEFAULT_MAX_MEDIAN_MS,
);

try {
	const output = outputPath
		? await readFile(outputPath, "utf8")
		: await runBenchmark(caseName);
	const medianMs = parseBenchmarkMetric(output, caseName, "median");
	if (medianMs == null) fail(`missing benchmark median for ${caseName}`);
	if (medianMs > maxMedianMs) {
		fail(
			`${caseName} median ${formatMs(medianMs)} exceeds ${formatMs(maxMedianMs)}`,
		);
	}
	outputLine(
		`benchmark gate ok: ${caseName} median ${formatMs(medianMs)} <= ${formatMs(maxMedianMs)}`,
	);
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	fail(message);
}

function runBenchmark(targetCase) {
	return new Promise((resolve, reject) => {
		const env = {
			...process.env,
			BENCH_CASES: targetCase,
			BENCH_ITERS: process.env.BENCH_ITERS || DEFAULT_ITERS,
			BENCH_WARMUP: process.env.BENCH_WARMUP || DEFAULT_WARMUP,
		};
		execFile(
			process.execPath,
			["scripts/bench.mjs"],
			{ cwd: process.cwd(), env },
			(error, stdout, stderr) => {
				if (stdout) process.stdout.write(stdout);
				if (stderr) process.stderr.write(stderr);
				if (error) reject(error);
				else resolve(stdout);
			},
		);
	});
}

export function parseBenchmarkMetric(output, benchmarkCaseName, metricName) {
	const line = String(output || "")
		.split(/\r?\n/)
		.find((candidate) =>
			candidate.trimStart().startsWith(`${benchmarkCaseName} `),
		);
	if (!line) return null;
	const match = new RegExp(
		`\\b${escapeRegex(metricName)}=([0-9]+(?:\\.[0-9]+)?)(us|ms|s)\\b`,
	).exec(line);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return null;
	switch (match[2]) {
		case "us":
			return value / 1000;
		case "ms":
			return value;
		case "s":
			return value * 1000;
		default:
			return null;
	}
}

function positiveNumber(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function formatMs(ms) {
	if (ms < 1) return `${(ms * 1000).toFixed(1)}us`;
	return `${ms.toFixed(3)}ms`;
}

function escapeRegex(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
	errorLine(`Benchmark gate failed: ${message}`);
	process.exit(1);
}
