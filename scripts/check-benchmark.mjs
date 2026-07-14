import { readFile } from "node:fs/promises";
import { errorLine, outputLine } from "./io.mjs";
import { outputCommand } from "./process.mjs";

const DEFAULT_CASE = "stream_sieve_held_tool";
const DEFAULT_MAX_MEDIAN_MS = 20;
const DEFAULT_ITERS = "80";
const DEFAULT_WARMUP = "10";
const DEFAULT_BUDGETS = Object.freeze({
	stream_sieve_held_tool: 8,
	stream_text_cumulative_deltas: 12,
	socket_chunked_long_split_line: 8,
	structured_unique_items: 4,
	account_admin_overview: 0.1,
	account_admin_bulk_action: 0.5,
});

const outputPath = process.argv[2] || "";

try {
	const budgets = benchmarkBudgets(outputPath);
	const output = outputPath
		? await readFile(outputPath, "utf8")
		: await runBenchmark(Object.keys(budgets));
	const results = parseBenchmarkResults(output);
	for (const [caseName, maxMedianMs] of Object.entries(budgets)) {
		const medianMs = results.get(caseName)?.medianMs ?? null;
		if (medianMs == null) fail(`missing benchmark median for ${caseName}`);
		if (medianMs > maxMedianMs) {
			fail(
				`${caseName} median ${formatMs(medianMs)} exceeds ${formatMs(maxMedianMs)}`,
			);
		}
		outputLine(
			`benchmark gate ok: ${caseName} median ${formatMs(medianMs)} <= ${formatMs(maxMedianMs)}`,
		);
	}
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	fail(message);
}

function benchmarkBudgets(inputPath) {
	const rawBudgets = String(process.env.BENCH_GATE_BUDGETS || "").trim();
	if (rawBudgets) {
		let parsed;
		try {
			parsed = JSON.parse(rawBudgets);
		} catch (_) {
			throw new Error("BENCH_GATE_BUDGETS must be a JSON object");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("BENCH_GATE_BUDGETS must be a JSON object");
		const out = {};
		for (const [name, value] of Object.entries(parsed)) {
			const budget = positiveNumber(value, 0);
			if (!name.trim() || budget <= 0)
				throw new Error(`invalid benchmark budget for ${name || "<empty>"}`);
			out[name] = budget;
		}
		if (!Object.keys(out).length)
			throw new Error("BENCH_GATE_BUDGETS must not be empty");
		return out;
	}

	const explicitCase = String(process.env.BENCH_GATE_CASE || "").trim();
	if (explicitCase || inputPath) {
		return {
			[explicitCase || DEFAULT_CASE]: positiveNumber(
				process.env.BENCH_MAX_MEDIAN_MS,
				DEFAULT_MAX_MEDIAN_MS,
			),
		};
	}
	return { ...DEFAULT_BUDGETS };
}

function runBenchmark(targetCases) {
	return outputCommand(process.execPath, ["scripts/bench.mjs"], {
		env: {
			...process.env,
			BENCH_CASES: targetCases.join(","),
			BENCH_ITERS: process.env.BENCH_ITERS || DEFAULT_ITERS,
			BENCH_WARMUP: process.env.BENCH_WARMUP || DEFAULT_WARMUP,
			BENCH_JSON: "1",
		},
	});
}

export function parseBenchmarkResults(output) {
	const raw = String(output || "").trim();
	if (raw.startsWith("{")) {
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (_) {
			throw new Error("invalid benchmark JSON output");
		}
		if (!Array.isArray(parsed?.results))
			throw new Error("benchmark JSON output is missing results");
		const out = new Map();
		for (const result of parsed.results) {
			const name = String(result?.name || "").trim();
			const medianMs = result?.medianMs;
			if (name && typeof medianMs === "number" && Number.isFinite(medianMs))
				out.set(name, { medianMs });
		}
		return out;
	}

	const out = new Map();
	for (const line of raw.split(/\r?\n/)) {
		const name = /^\s*([^\s]+)\s+/.exec(line)?.[1] || "";
		if (!name) continue;
		const medianMs = parseBenchmarkMetric(line, name, "median");
		if (medianMs != null) out.set(name, { medianMs });
	}
	return out;
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
