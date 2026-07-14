import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { errorLine, outputLine } from "./io.mjs";

const root = process.cwd();
const rules = [
	{
		label: "attachment modules must stay provider-neutral",
		files: "src/attachments/**/*.{ts,tsx}",
		disallowed: ["../"],
		allowed: ["../shared"],
	},
	{
		label: "admin UI modules must stay browser-boundary only",
		files: "src/admin-ui/**/*.{ts,tsx}",
		disallowedOutside: "src/admin-ui",
	},
	{
		label: "shared modules must stay leaf-level",
		files: "src/shared/**/*.ts",
		disallowed: [
			"../gemini/",
			"../http/",
			"../promptcompat/",
			"../toolcall/",
			"../toolstream/",
			"./gemini/",
			"./http/",
			"./promptcompat/",
			"./toolcall/",
			"./toolstream/",
		],
	},
	{
		label: "gemini client must not depend on prompt compatibility",
		files: "src/gemini/client/**/*.ts",
		disallowed: ["../../promptcompat/", "../promptcompat/"],
	},
	{
		label: "prompt compatibility must not depend on HTTP adapters",
		files: "src/promptcompat/**/*.ts",
		disallowed: ["../http/", "../../http/"],
	},
	{
		label: "completion modules must not depend on HTTP adapters",
		files: "src/completion/**/*.ts",
		disallowed: ["../http/", "../../http/"],
	},
	{
		label:
			"completion modules must depend on provider ports instead of Gemini implementation packages",
		files: "src/completion/**/*.ts",
		disallowed: ["../gemini/", "../../gemini/"],
	},
	{
		label:
			"completion modules must import prompt compatibility owner modules instead of the compatibility barrel",
		files: "src/completion/**/*.ts",
		disallowed: [
			"../promptcompat",
			"../promptcompat/",
			"../../promptcompat",
			"../../promptcompat/",
		],
		allowed: [
			"../promptcompat/file-refs",
			"../promptcompat/google",
			"../promptcompat/history",
			"../promptcompat/messages",
			"../promptcompat/prompt-build",
			"../promptcompat/responses-input",
			"../../promptcompat/file-refs",
			"../../promptcompat/google",
			"../../promptcompat/history",
			"../../promptcompat/messages",
			"../../promptcompat/prompt-build",
			"../../promptcompat/responses-input",
		],
	},
	{
		label: "HTTP adapters must not call Gemini client directly",
		files: "src/http/**/*.ts",
		disallowed: [
			"../gemini/client",
			"../gemini/client/",
			"../../gemini/client",
			"../../gemini/client/",
		],
	},
	{
		label:
			"Gemini implementation must only depend on completion ports through its provider adapter",
		files: "src/gemini/**/*.ts",
		disallowed: [
			"../completion",
			"../completion/",
			"../../completion",
			"../../completion/",
		],
		allowed: ["../completion/ports", "../../completion/ports"],
	},
	{
		label:
			"HTTP protocol adapters must import core helpers directly instead of the HTTP barrel",
		files: "src/http/{openai,google}/**/*.ts",
		disallowed: ["../index", "../index.ts", "../../http", "../../http/"],
	},
	{
		label: "HTTP adapters must not consume tool stream state directly",
		files: "src/http/**/*.ts",
		disallowed: [
			"../toolstream",
			"../toolstream/",
			"../../toolstream",
			"../../toolstream/",
		],
	},
	{
		label: "HTTP adapter barrels must not re-export lower-layer internals",
		files: "src/http/**/index.ts",
		disallowed: [
			"../../completion",
			"../../completion/",
			"../../promptcompat",
			"../../promptcompat/",
			"../../toolcall",
			"../../toolcall/",
			"../../gemini",
			"../../gemini/",
		],
	},
	{
		label: "prompt compatibility must not perform Gemini uploads",
		files: "src/promptcompat/**/*.ts",
		disallowed: [
			"../gemini/uploads",
			"../gemini/uploads/",
			"../../gemini/uploads",
			"../../gemini/uploads/",
		],
	},
	{
		label:
			"prompt compatibility internals must not depend on completion modules",
		files: "src/promptcompat/**/*.ts",
		disallowed: [
			"../completion",
			"../completion/",
			"../../completion",
			"../../completion/",
		],
	},
	{
		label: "google HTTP adapter must not depend on openai HTTP adapter",
		files: "src/http/google/**/*.ts",
		disallowed: ["../openai/", "../../http/openai/"],
	},
	{
		label: "openai HTTP adapter must not depend on google HTTP adapter",
		files: "src/http/openai/**/*.ts",
		disallowed: ["../google/", "../../http/google/"],
	},
	{
		label: "toolcall must not depend on prompt compatibility",
		files: "src/toolcall/**/*.ts",
		disallowed: ["../promptcompat/", "../../promptcompat/"],
	},
	{
		label: "toolcall must not depend on HTTP adapters or stream state",
		files: "src/toolcall/**/*.ts",
		disallowed: [
			"../http/",
			"../../http/",
			"../toolstream/",
			"../../toolstream/",
		],
	},
	{
		label: "toolcall must not depend on Gemini upload modules",
		files: "src/toolcall/**/*.ts",
		disallowed: [
			"../gemini/uploads",
			"../gemini/uploads/",
			"../../gemini/uploads",
			"../../gemini/uploads/",
		],
	},
	{
		label:
			"implementation modules must import toolcall owner modules instead of the compatibility barrel",
		files: "src/{completion,promptcompat,toolstream,http}/**/*.ts",
		disallowedExact: [
			"../toolcall",
			"../toolcall/index",
			"../toolcall/index.ts",
			"../../toolcall",
			"../../toolcall/index",
			"../../toolcall/index.ts",
		],
	},
	{
		label:
			"implementation modules must import attachment media owner modules instead of the shared media compatibility shim",
		files:
			"src/{completion,promptcompat,toolcall,toolstream,http,gemini}/**/*.ts",
		disallowed: ["../shared/media", "../../shared/media"],
	},
];

const importPattern =
	/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
const violations = [];

for (const rule of rules) {
	for (const file of globSync(rule.files, { cwd: root })) {
		if (rule.exceptFiles?.includes(normalizeSourcePath(file))) continue;
		const text = await readFile(resolve(root, file), "utf8");
		for (const match of text.matchAll(importPattern)) {
			const specifier = match[1];
			if (rule.disallowedOutside && specifier.startsWith(".")) {
				const resolvedSpecifier = normalizeSourcePath(
					relative(root, resolve(dirname(resolve(root, file)), specifier)),
				);
				if (
					resolvedSpecifier !== rule.disallowedOutside &&
					!resolvedSpecifier.startsWith(`${rule.disallowedOutside}/`)
				) {
					violations.push(
						`${normalizeSourcePath(relative(root, resolve(root, file)))}: ${specifier} (${rule.label})`,
					);
					continue;
				}
			}
			if (
				rule.allowed?.some(
					(prefix) =>
						specifier === prefix || specifier.startsWith(`${prefix}/`),
				)
			)
				continue;
			if (rule.disallowedExact?.includes(specifier)) {
				violations.push(
					`${normalizeSourcePath(relative(root, resolve(root, file)))}: ${specifier} (${rule.label})`,
				);
				continue;
			}
			if (
				rule.disallowed?.some(
					(prefix) => specifier === prefix || specifier.startsWith(prefix),
				)
			) {
				violations.push(
					`${normalizeSourcePath(relative(root, resolve(root, file)))}: ${specifier} (${rule.label})`,
				);
			}
		}
	}
}

const sourceFiles = globSync("src/**/*.{ts,tsx}", { cwd: root }).map(
	normalizeSourcePath,
);
const sourceFileSet = new Set(sourceFiles);
const importGraph = new Map();

for (const file of sourceFiles) {
	const text = await readFile(resolve(root, file), "utf8");
	const deps = [];
	for (const match of text.matchAll(importPattern)) {
		const specifier = match[1];
		if (!specifier.startsWith(".")) continue;
		const dep = resolveSourceImport(file, specifier);
		if (dep && sourceFileSet.has(dep)) deps.push(dep);
	}
	importGraph.set(file, deps);
}

for (const cycle of findImportCycles(importGraph)) {
	violations.push(
		`${cycle.join(" -> ")} (source modules must not form import cycles)`,
	);
}

const packageGraph = buildPackageGraph(sourceFiles, sourceFileSet);
for (const cycle of findImportCycles(packageGraph)) {
	violations.push(
		`${cycle.join(" -> ")} (source directories must not form dependency cycles)`,
	);
}

if (violations.length) {
	errorLine("Architecture check failed:");
	for (const violation of violations) errorLine(`- ${violation}`);
	process.exit(1);
}

outputLine("Architecture check passed");

function resolveSourceImport(fromFile, specifier) {
	const base = normalizeSourcePath(join(dirname(fromFile), specifier));
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		normalizeSourcePath(join(base, "index.ts")),
		normalizeSourcePath(join(base, "index.tsx")),
	];
	for (const candidate of candidates) {
		const absolute = resolve(root, candidate);
		if (existsSync(absolute) && statSync(absolute).isFile())
			return normalizeSourcePath(candidate);
	}
	return null;
}

function findImportCycles(graph) {
	const cycles = [];
	const seen = new Set();
	const active = new Set();
	const stack = [];
	const cycleKeys = new Set();

	function visit(node) {
		seen.add(node);
		active.add(node);
		stack.push(node);
		for (const dep of graph.get(node) || []) {
			if (!graph.has(dep)) continue;
			if (!seen.has(dep)) {
				visit(dep);
				continue;
			}
			if (!active.has(dep)) continue;
			const start = stack.indexOf(dep);
			const cycle = stack.slice(start).concat(dep);
			const key = cycle.slice(0, -1).sort().join("|");
			if (!cycleKeys.has(key)) {
				cycleKeys.add(key);
				cycles.push(cycle);
			}
		}
		stack.pop();
		active.delete(node);
	}

	for (const node of graph.keys()) {
		if (!seen.has(node)) visit(node);
	}
	return cycles;
}

function buildPackageGraph(files, fileSet) {
	const graph = new Map();
	const packageOwners = new Set(
		files.map(sourcePackage).filter((owner) => owner && owner !== "generated"),
	);
	for (const owner of packageOwners) graph.set(owner, []);

	for (const file of files) {
		const fromOwner = sourcePackage(file);
		if (!packageOwners.has(fromOwner)) continue;
		const text = readSourceFileSync(file);
		for (const match of text.matchAll(importPattern)) {
			const specifier = match[1];
			if (!specifier.startsWith(".")) continue;
			const dep = resolveSourceImport(file, specifier);
			if (!dep || !fileSet.has(dep)) continue;
			const toOwner = sourcePackage(dep);
			if (!packageOwners.has(toOwner) || toOwner === fromOwner) continue;
			const deps = graph.get(fromOwner);
			if (deps && !deps.includes(toOwner)) deps.push(toOwner);
		}
	}

	return graph;
}

function sourcePackage(file) {
	const match = /^src\/([^/]+)\//.exec(file);
	return match?.[1] ? match[1] : "";
}

function readSourceFileSync(file) {
	return readFileSync(resolve(root, file), "utf8");
}

function normalizeSourcePath(file) {
	return normalize(file).replaceAll("\\", "/");
}
