import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assert } from "./assertions.js";
import { mod } from "./helpers.js";

const DEPLOY_SECRET_TEMPLATE_KEYS = ["ADMIN_KEYS", "API_KEYS"];
const DEPLOY_SECRET_KEYS = new Set([
	...DEPLOY_SECRET_TEMPLATE_KEYS,
	"ADMIN_KEY",
]);
const DOCKER_ONLY_ENV_KEYS = [
	"PORT",
	"WEB2GEM_IMAGE",
	"D1_ACCOUNT_ID",
	"D1_DATABASE_ID",
	"D1_API_TOKEN",
];

export const suiteName = "quality scripts";
export const cases = [
	[
		"accepts authored TSX files that stay inside their owner boundary",
		async () => {
			await withArchitectureFixture(
				{
					"src/admin-ui/app.tsx":
						'import { state } from "./state";\nvoid state;\n',
					"src/admin-ui/state.ts": "export const state = 1;\n",
				},
				async (dir) => {
					const result = await runArchitectureCheck(dir);
					assert.equal(result.code, 0);
					assert.match(result.stdout, /Architecture check passed/);
				},
			);
		},
	],
	[
		"rejects backend imports from authored admin UI TSX files",
		async () => {
			await withArchitectureFixture(
				{
					"src/admin-ui/app.tsx": 'import "../gemini/client";\n',
					"src/gemini/client/index.ts": "export const client = 1;\n",
				},
				async (dir) => {
					const result = await runArchitectureCheck(dir);
					assert.equal(result.code, 1);
					assert.match(
						result.stderr,
						/admin UI modules must stay browser-boundary only/,
					);
				},
			);
		},
	],
	[
		"rejects provider imports from attachment modules",
		async () => {
			await withArchitectureFixture(
				{
					"src/attachments/plan.ts": 'import "../gemini/client";\n',
					"src/gemini/client/index.ts": "export const client = 1;\n",
				},
				async (dir) => {
					const result = await runArchitectureCheck(dir);
					assert.equal(result.code, 1);
					assert.match(
						result.stderr,
						/attachment modules must stay provider-neutral/,
					);
				},
			);
		},
	],
	[
		"rejects cycles between dynamically discovered source owners",
		async () => {
			await withArchitectureFixture(
				{
					"src/alpha/a1.ts": 'import "../beta/b1";\n',
					"src/alpha/a2.ts": "export const a = 1;\n",
					"src/beta/b1.ts": "export const b = 1;\n",
					"src/beta/b2.ts": 'import "../alpha/a2";\n',
				},
				async (dir) => {
					const result = await runArchitectureCheck(dir);
					assert.equal(result.code, 1);
					assert.match(
						result.stderr,
						/source directories must not form dependency cycles/,
					);
					assert.match(
						result.stderr,
						/alpha -> beta -> alpha|beta -> alpha -> beta/,
					);
				},
			);
		},
	],
	[
		"accepts coverage summaries that satisfy line and branch gates",
		async () => {
			await withCoverageSummary(fullCoverageSummary(), async (summaryPath) => {
				const result = await runNodeScript(
					"scripts/check-coverage.mjs",
					summaryPath,
				);
				assert.equal(result.code, 0);
				assert.match(result.stdout, /Coverage gates passed/);
			});
		},
	],
	[
		"rejects coverage summaries below branch gates",
		async () => {
			const summary = fullCoverageSummary();
			summary["src/toolcall/structured.ts"].branches.covered = 54;
			await withCoverageSummary(summary, async (summaryPath) => {
				const result = await runNodeScript(
					"scripts/check-coverage.mjs",
					summaryPath,
				);
				assert.equal(result.code, 1);
				assert.match(result.stderr, /Coverage gate failed/);
				assert.match(result.stderr, /src\/toolcall\/structured\.ts/);
			});
		},
	],
	[
		"rejects missing coverage data for required targets",
		async () => {
			const summary = fullCoverageSummary();
			delete summary["src/http/admin/gemini-accounts.ts"];
			await withCoverageSummary(summary, async (summaryPath) => {
				const result = await runNodeScript(
					"scripts/check-coverage.mjs",
					summaryPath,
				);
				assert.equal(result.code, 1);
				assert.match(result.stderr, /missing lines coverage data/);
				assert.match(result.stderr, /src\/http\/admin/);
			});
		},
	],
	[
		"accepts bundle size within the configured budget",
		async () => {
			await withTempFile("worker.js", "x".repeat(128), async (bundlePath) => {
				const result = await runNodeScript(
					"scripts/check-bundle-size.mjs",
					bundlePath,
					{
						BUNDLE_SIZE_LIMIT_BYTES: "256",
					},
				);
				assert.equal(result.code, 0);
				assert.match(result.stdout, /bundle size ok/);
			});
		},
	],
	[
		"rejects bundle size over the configured budget",
		async () => {
			await withTempFile("worker.js", "x".repeat(257), async (bundlePath) => {
				const result = await runNodeScript(
					"scripts/check-bundle-size.mjs",
					bundlePath,
					{
						BUNDLE_SIZE_LIMIT_BYTES: "256",
					},
				);
				assert.equal(result.code, 1);
				assert.match(result.stderr, /Bundle size gate failed/);
			});
		},
	],
	[
		"accepts benchmark medians within the configured budget",
		async () => {
			await withTempFile(
				"bench.txt",
				"stream_sieve_held_tool          n=20  median=12.500ms  p95=13.000ms\n",
				async (benchPath) => {
					const result = await runNodeScript(
						"scripts/check-benchmark.mjs",
						benchPath,
						{
							BENCH_MAX_MEDIAN_MS: "20",
						},
					);
					assert.equal(result.code, 0);
					assert.match(result.stdout, /benchmark gate ok/);
				},
			);
		},
	],
	[
		"rejects benchmark medians over the configured budget",
		async () => {
			await withTempFile(
				"bench.txt",
				"stream_sieve_held_tool          n=20  median=25.000ms  p95=26.000ms\n",
				async (benchPath) => {
					const result = await runNodeScript(
						"scripts/check-benchmark.mjs",
						benchPath,
						{
							BENCH_MAX_MEDIAN_MS: "20",
						},
					);
					assert.equal(result.code, 1);
					assert.match(result.stderr, /Benchmark gate failed/);
				},
			);
		},
	],
	[
		"parses microsecond benchmark output for the performance gate",
		async () => {
			await withTempFile(
				"bench.txt",
				"stream_sieve_held_tool          n=20  median=850.0us  p95=900.0us\n",
				async (benchPath) => {
					const result = await runNodeScript(
						"scripts/check-benchmark.mjs",
						benchPath,
						{
							BENCH_MAX_MEDIAN_MS: "1",
						},
					);
					assert.equal(result.code, 0);
					assert.match(result.stdout, /850\.0us <= 1\.000ms/);
				},
			);
		},
	],
	[
		"skips Docker smoke when Docker is not installed",
		async () => {
			await withTempDir(async (dir) => {
				const result = await runNodeScript("scripts/docker-smoke.mjs", null, {
					PATH: dir,
				});
				assert.equal(result.code, 0);
				assert.match(
					result.stdout,
					/Docker smoke skipped: docker executable not found/,
				);
			});
		},
	],
	[
		"keeps Docker Compose port mapping aligned with the container listener",
		async () => {
			const compose = await readFile("compose.yaml", "utf8");
			assert.match(compose, /\$\{PORT:-52389\}:\$\{PORT:-52389\}/);
			assert.doesNotMatch(compose, /\$\{PORT:-52389\}:52389/);
		},
	],
	[
		"keeps runtime config env keys aligned with Docker docs and Compose",
		async () => {
			const dockerEnvExample = parseEnvExampleKeys(
				await readFile(".env.docker.example", "utf8"),
			);
			const compose = await readFile("compose.yaml", "utf8");
			const composeEnv = parseComposeEnvironmentKeys(compose);
			const composeVariables = parseComposeVariableReferences(compose);
			const configKeys = mod.CONFIG_ENV_KEYS;

			assert.deepEqual(missingKeys(configKeys, dockerEnvExample), []);
			assert.deepEqual(missingKeys(configKeys, composeEnv), []);
			assert.deepEqual(missingKeys(DOCKER_ONLY_ENV_KEYS, dockerEnvExample), []);
			assert.deepEqual(missingKeys(DOCKER_ONLY_ENV_KEYS, composeVariables), []);
		},
	],
	[
		"keeps Deploy Button secrets separate from visible Worker vars",
		async () => {
			const deploySecretTemplates = [".env.example", ".dev.vars.example"];
			const deploySecretsByTemplate = new Map();
			for (const path of deploySecretTemplates) {
				deploySecretsByTemplate.set(
					path,
					parseEnvExampleKeys(await readFile(path, "utf8")),
				);
			}
			const wrangler = parseJsoncObject(
				await readFile("wrangler.jsonc", "utf8"),
			);
			const workerVars = new Set(Object.keys(wrangler.vars || {}));
			const expectedVisibleVars = mod.CONFIG_ENV_KEYS.filter(
				(key) => !DEPLOY_SECRET_KEYS.has(key),
			);

			assert.deepEqual(missingKeys(expectedVisibleVars, workerVars), []);
			assert.deepEqual(
				[...DEPLOY_SECRET_KEYS].filter((key) => workerVars.has(key)),
				[],
			);
			for (const [path, deploySecrets] of deploySecretsByTemplate) {
				assert.deepEqual(
					[...deploySecrets].sort(),
					DEPLOY_SECRET_TEMPLATE_KEYS,
					path,
				);
				assert.deepEqual(
					expectedVisibleVars.filter((key) => deploySecrets.has(key)),
					[],
					path,
				);
				assert.deepEqual(
					DOCKER_ONLY_ENV_KEYS.filter((key) => deploySecrets.has(key)),
					[],
					path,
				);
			}
		},
	],
	[
		"parses JSONC config syntax without treating URL-like strings as comments",
		() => {
			const wrangler = parseJsoncObject(`{
      // JSONC line comment
      "vars": {
        "GEMINI_ORIGIN": "https://gemini.google.com",
        "COMMENT_TEXT": "keep /* this */ and // this",
      },
    }`);

			assert.deepEqual(wrangler.vars, {
				GEMINI_ORIGIN: "https://gemini.google.com",
				COMMENT_TEXT: "keep /* this */ and // this",
			});
		},
	],
];

function coverageEntry(linePct = 100, branchPct = 100) {
	return {
		lines: { total: 100, covered: linePct, skipped: 0, pct: linePct },
		statements: { total: 100, covered: linePct, skipped: 0, pct: linePct },
		functions: { total: 100, covered: 100, skipped: 0, pct: 100 },
		branches: { total: 100, covered: branchPct, skipped: 0, pct: branchPct },
	};
}

function fullCoverageSummary() {
	return {
		total: coverageEntry(),
		"src/attachments/plan.ts": coverageEntry(),
		"src/completion/index.ts": coverageEntry(),
		"src/config/index.ts": coverageEntry(),
		"src/gemini/accounts/pool.ts": coverageEntry(),
		"src/gemini/app-page.ts": coverageEntry(),
		"src/gemini/index.ts": coverageEntry(),
		"src/gemini/client/index.ts": coverageEntry(),
		"src/gemini/client/parser.ts": coverageEntry(),
		"src/gemini/transport/http.ts": coverageEntry(),
		"src/gemini/uploads/index.ts": coverageEntry(),
		"src/http/core/json.ts": coverageEntry(),
		"src/http/admin/gemini-accounts.ts": coverageEntry(),
		"src/http/google/handlers.ts": coverageEntry(),
		"src/http/openai/chat.ts": coverageEntry(),
		"src/http/openai/responses.ts": coverageEntry(),
		"src/http/openai/responses-stream.ts": coverageEntry(),
		"src/http/stream/coalescer.ts": coverageEntry(),
		"src/models/index.ts": coverageEntry(),
		"src/promptcompat/history.ts": coverageEntry(),
		"src/promptcompat/messages.ts": coverageEntry(),
		"src/promptcompat/responses-input.ts": coverageEntry(),
		"src/shared/tokens.ts": coverageEntry(),
		"src/toolcall/markdown.ts": coverageEntry(),
		"src/toolcall/structured.ts": coverageEntry(),
		"src/toolstream/index.ts": coverageEntry(),
	};
}

async function withCoverageSummary(summary, run) {
	const dir = await mkdtemp(join(tmpdir(), "gemini-coverage-"));
	try {
		const summaryPath = join(dir, "coverage-summary.json");
		await writeFile(summaryPath, JSON.stringify(summary), "utf8");
		await run(summaryPath);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function withTempFile(filename, body, run) {
	const dir = await mkdtemp(join(tmpdir(), "gemini-script-"));
	try {
		const path = join(dir, filename);
		await writeFile(path, body, "utf8");
		await run(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function withTempDir(run) {
	const dir = await mkdtemp(join(tmpdir(), "gemini-script-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function withArchitectureFixture(files, run) {
	const dir = await mkdtemp(join(tmpdir(), "gemini-architecture-"));
	try {
		for (const [relativePath, body] of Object.entries(files)) {
			const path = join(dir, relativePath);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, body, "utf8");
		}
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function runArchitectureCheck(cwd) {
	return runNodeScript(
		resolve(process.cwd(), "scripts/check-architecture.mjs"),
		null,
		{},
		cwd,
	);
}

function runNodeScript(script, arg, env = {}, cwd = process.cwd()) {
	return new Promise((resolve) => {
		const args = arg == null ? [script] : [script, arg];
		execFile(
			process.execPath,
			args,
			{ cwd, env: { ...process.env, ...env } },
			(error, stdout, stderr) => {
				resolve({
					code: error && typeof error.code === "number" ? error.code : 0,
					stdout,
					stderr,
				});
			},
		);
	});
}

function parseEnvExampleKeys(source) {
	const keys = new Set();
	for (const line of source.split(/\r?\n/)) {
		const match = /^([A-Z0-9_]+)=/.exec(line.trim());
		if (match) keys.add(match[1]);
	}
	return keys;
}

function parseComposeEnvironmentKeys(source) {
	const keys = new Set();
	for (const line of source.split(/\r?\n/)) {
		const match = /^\s{6}([A-Z0-9_]+):/.exec(line);
		if (match) keys.add(match[1]);
	}
	return keys;
}

function parseComposeVariableReferences(source) {
	const keys = new Set();
	for (const match of source.matchAll(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g)) {
		keys.add(match[1]);
	}
	return keys;
}

function parseJsoncObject(source) {
	return JSON.parse(removeTrailingJsoncCommas(stripJsoncComments(source)));
}

function stripJsoncComments(source) {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		const next = source[i + 1];
		if (inString) {
			out += char;
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		if (char === "/" && next === "/") {
			while (i < source.length && !/\r|\n/.test(source[i])) i++;
			out += source[i] || "";
			continue;
		}
		if (char === "/" && next === "*") {
			i += 2;
			while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
				i++;
			i++;
			continue;
		}
		out += char;
	}
	return out;
}

function removeTrailingJsoncCommas(source) {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (inString) {
			out += char;
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		if (char === ",") {
			let nextIndex = i + 1;
			while (/\s/.test(source[nextIndex] || "")) nextIndex++;
			if (source[nextIndex] === "}" || source[nextIndex] === "]") continue;
		}
		out += char;
	}
	return out;
}

function missingKeys(expected, actual) {
	return expected.filter((key) => !actual.has(key));
}
