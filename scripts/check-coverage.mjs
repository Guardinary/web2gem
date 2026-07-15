import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { errorLine, outputLine } from "./io.mjs";

const summaryPath = process.argv[2] || "coverage/coverage-summary.json";

const sourceGates = [
	["statements", 86],
	["branches", 76],
	["functions", 88],
	["lines", 89],
];

// Critical-path gates only; everything else is held by the global gates.
// Values are observed post-migration actuals minus a small margin.
const lineGates = [
	["src/completion", 92],
	["src/gemini/accounts", 80],
	["src/gemini/completion-provider.ts", 95],
	["src/gemini/transport", 90],
	["src/http/google", 92],
	["src/http/openai", 92],
	["src/promptcompat", 94],
	["src/toolcall", 90],
];

const branchGates = [
	["src/completion", 80],
	["src/gemini/accounts", 65],
	["src/gemini/completion-provider.ts", 85],
	["src/gemini/transport", 78],
	["src/http/google", 75],
	["src/http/openai", 78],
	["src/promptcompat", 78],
	["src/toolcall", 78],
];

const summary = JSON.parse(await readFile(summaryPath, "utf8"));
const cwd = process.cwd();

function normalizePath(path) {
	const rel = path.startsWith(cwd) ? relative(cwd, path) : path;
	return rel.split("\\").join("/");
}

function statsForDir(dir, metric) {
	let covered = 0;
	let total = 0;

	for (const [key, entry] of Object.entries(summary)) {
		if (key === "total") continue;
		const rel = normalizePath(key);
		if (!rel.startsWith(`${dir}/`)) continue;
		if (!entry || typeof entry !== "object" || !entry[metric]) continue;
		const stats = entry[metric];
		covered += Number(stats.covered || 0);
		total += Number(stats.total || 0);
	}

	return { covered, total, pct: total > 0 ? (covered / total) * 100 : 0 };
}

function statsForPath(path, metric) {
	let covered = 0;
	let total = 0;
	const normalizedPath = path.split("\\").join("/");

	for (const [key, entry] of Object.entries(summary)) {
		if (key === "total") continue;
		const rel = normalizePath(key);
		if (rel !== normalizedPath) continue;
		if (!entry || typeof entry !== "object" || !entry[metric]) continue;
		const stats = entry[metric];
		covered += Number(stats.covered || 0);
		total += Number(stats.total || 0);
	}

	return { covered, total, pct: total > 0 ? (covered / total) * 100 : 0 };
}

function statsForTarget(target, metric) {
	if (/\.tsx?$/.test(target)) return statsForPath(target, metric);
	return statsForDir(target, metric);
}

const failures = [];

for (const [metric, threshold] of sourceGates) {
	checkGate("src", threshold, metric);
}

for (const [target, threshold] of lineGates) {
	checkGate(target, threshold, "lines");
}

for (const [target, threshold] of branchGates) {
	checkGate(target, threshold, "branches");
}

function checkGate(target, threshold, metric) {
	const stats = statsForTarget(target, metric);
	const pct = Number(stats.pct.toFixed(2));
	const rendered = `${target}: ${pct.toFixed(2)}% ${metric} (${stats.covered}/${stats.total}), required ${threshold.toFixed(2)}%`;

	if (stats.total === 0) {
		failures.push(`${target}: missing ${metric} coverage data`);
		return;
	}

	if (pct + 0.001 < threshold) {
		failures.push(rendered);
		return;
	}

	outputLine(`coverage ok: ${rendered}`);
}

if (failures.length) {
	errorLine("Coverage gate failed:");
	for (const failure of failures) errorLine(`- ${failure}`);
	process.exit(1);
}

outputLine("Coverage gates passed");
