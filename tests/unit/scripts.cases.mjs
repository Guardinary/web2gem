import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assert } from "./assertions.js";
import { mod } from "./helpers.js";

const DEPLOY_SECRET_TEMPLATE_KEYS = ["ADMIN_KEY", "API_KEYS"];
const DEPLOY_SECRET_KEYS = new Set(DEPLOY_SECRET_TEMPLATE_KEYS);
const DEPLOY_BUTTON_REPOSITORY =
	"https://github.com/Guardinary/web2gem/tree/gemini-account-pool";
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
		"ignores third-party coverage when evaluating source gates",
		async () => {
			const summary = fullCoverageSummary();
			summary["node_modules/example/index.mjs"] = coverageEntry(0, 0);
			await withCoverageSummary(summary, async (summaryPath) => {
				const result = await runNodeScript(
					"scripts/check-coverage.mjs",
					summaryPath,
				);
				assert.equal(result.code, 0);
				assert.match(result.stdout, /src: 100\.00% lines/);
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
		"rejects completion provider coverage below its file gates",
		async () => {
			const summary = fullCoverageSummary();
			summary["src/gemini/completion-provider.ts"] = coverageEntry(94, 84);
			await withCoverageSummary(summary, async (summaryPath) => {
				const result = await runNodeScript(
					"scripts/check-coverage.mjs",
					summaryPath,
				);
				assert.equal(result.code, 1);
				assert.match(result.stderr, /src\/gemini\/completion-provider\.ts/);
				assert.match(result.stderr, /94\.00% lines/);
				assert.match(result.stderr, /84\.00% branches/);
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
						BUNDLE_GZIP_SIZE_LIMIT_BYTES: "256",
					},
				);
				assert.equal(result.code, 0);
				assert.match(result.stdout, /bundle size ok/);
				assert.match(result.stdout, /raw 128 bytes, gzip \d+ bytes/);
				assert.match(result.stdout, /headroom \d+ bytes/);
			});
		},
	],
	[
		"classifies documentation-only and runtime-impacting CI changes",
		async () => {
			for (const [files, expected] of [
				[["README.md", "docs/images/example.png"], "docs"],
				[["src/index.ts"], "runtime"],
				[[".github/workflows/quality-gates.yml"], "runtime"],
				[[".trellis/spec/web2gem/backend/index.md"], "runtime"],
				[["migrations/0001_gemini_accounts.sql"], "runtime"],
				[["src/admin-ui/app.tsx"], "runtime"],
				[[], "runtime"],
			]) {
				const result = await runNodeScript(
					"scripts/classify-ci-changes.mjs",
					null,
					{ CI_CHANGED_FILES_JSON: JSON.stringify(files) },
				);
				assert.equal(result.code, 0);
				assert.equal(result.stdout.trim(), expected);
			}
		},
	],
	[
		"rejects bundle size over the configured budget",
		async () => {
			await withTempFile("worker.js", randomBytes(512), async (bundlePath) => {
				const result = await runNodeScript(
					"scripts/check-bundle-size.mjs",
					bundlePath,
					{
						BUNDLE_GZIP_SIZE_LIMIT_BYTES: "256",
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
		"accepts machine-readable multi-case benchmark results",
		async () => {
			await withTempFile(
				"bench.json",
				JSON.stringify({
					results: [
						{ name: "stream_sieve_held_tool", medianMs: 1.5 },
						{ name: "stream_text_cumulative_deltas", medianMs: 3.25 },
					],
				}),
				async (benchPath) => {
					const result = await runNodeScript(
						"scripts/check-benchmark.mjs",
						benchPath,
						{
							BENCH_GATE_BUDGETS: JSON.stringify({
								stream_sieve_held_tool: 2,
								stream_text_cumulative_deltas: 4,
							}),
						},
					);
					assert.equal(result.code, 0);
					assert.match(result.stdout, /stream_sieve_held_tool/);
					assert.match(result.stdout, /stream_text_cumulative_deltas/);
				},
			);
		},
	],
	[
		"emits machine-readable benchmark results",
		async () => {
			const result = await runNodeScript("scripts/bench.mjs", null, {
				BENCH_CASES: "rand_hex_32",
				BENCH_ITERS: "2",
				BENCH_WARMUP: "1",
				BENCH_JSON: "1",
			});
			assert.equal(result.code, 0);
			const parsed = JSON.parse(result.stdout);
			assert.deepEqual(parsed.filters, ["rand_hex_32"]);
			assert.equal(parsed.results.length, 1);
			assert.equal(parsed.results[0].name, "rand_hex_32");
			assert.equal(typeof parsed.results[0].medianMs, "number");
		},
	],
	[
		"keeps account admin benchmark fixtures aligned with the service contract",
		async () => {
			const result = await runNodeScript("scripts/bench.mjs", null, {
				BENCH_ACCOUNT_ADMIN_COUNT: "100",
				BENCH_CASES: "account_admin_overview,account_admin_bulk_action",
				BENCH_ITERS: "2",
				BENCH_WARMUP: "1",
				BENCH_JSON: "1",
			});
			assert.equal(result.code, 0, result.stderr);
			const parsed = JSON.parse(result.stdout);
			assert.deepEqual(
				parsed.results.map((entry) => entry.name),
				["account_admin_overview", "account_admin_bulk_action"],
			);
			for (const entry of parsed.results) {
				assert.equal(typeof entry.medianMs, "number");
			}
		},
	],
	[
		"reports an invalid benchmark bundle path",
		async () => {
			const result = await runNodeScript("scripts/bench.mjs", null, {
				BENCH_TEST_BUNDLE: "dist/missing-worker.test.js",
				BENCH_CASES: "rand_hex_32",
				BENCH_ITERS: "2",
				BENCH_WARMUP: "1",
				BENCH_JSON: "1",
			});
			assert.equal(result.code, 1);
			assert.match(result.stderr, /Benchmark bundle load failed/);
			assert.match(result.stderr, /missing-worker\.test\.js/);
		},
	],
	[
		"rejects machine-readable benchmark results missing a gated case",
		async () => {
			await withTempFile(
				"bench.json",
				JSON.stringify({
					results: [{ name: "stream_sieve_held_tool", medianMs: 1.5 }],
				}),
				async (benchPath) => {
					const result = await runNodeScript(
						"scripts/check-benchmark.mjs",
						benchPath,
						{
							BENCH_GATE_BUDGETS: JSON.stringify({
								stream_sieve_held_tool: 2,
								stream_text_cumulative_deltas: 4,
							}),
						},
					);
					assert.equal(result.code, 1);
					assert.match(
						result.stderr,
						/missing benchmark median for stream_text_cumulative_deltas/,
					);
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
			const dockerEnv = await readFile(".env.docker.example", "utf8");
			assert.match(compose, /\$\{PORT:-52389\}:\$\{PORT:-52389\}/);
			assert.doesNotMatch(compose, /\$\{PORT:-52389\}:52389/);
			for (const source of [compose, dockerEnv]) {
				assert.match(
					source,
					/ghcr\.io\/guardinary\/web2gem-account-pool:latest/,
				);
				assert.doesNotMatch(source, /ghcr\.io\/guardinary\/web2gem:latest/);
			}
			assert.match(
				compose,
				/REQUEST_BODY_MAX_BYTES:\s*"\$\{REQUEST_BODY_MAX_BYTES:-67108864\}"/,
			);
		},
	],
	[
		"copies every local Docker server runtime import into the final image",
		async () => {
			const server = await readFile("scripts/docker-server.mjs", "utf8");
			const dockerfile = await readFile("Dockerfile", "utf8");
			const runtimeImports = Array.from(
				server.matchAll(/from\s+["']\.\/(.+?\.mjs)["']/g),
				(match) => match[1],
			);
			assert.deepEqual(runtimeImports.sort(), [
				"d1-http-binding.mjs",
				"io.mjs",
			]);
			for (const filename of runtimeImports) {
				assert.match(
					dockerfile,
					new RegExp(
						`COPY --from=build /app/scripts/${filename.replace(".", "\\.")}`,
					),
				);
			}
		},
	],
	[
		"keeps Docker build contexts minimal without excluding build inputs",
		async () => {
			const patterns = (await readFile(".dockerignore", "utf8"))
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#"));
			const excluded = new Set(
				patterns.filter((line) => !line.startsWith("!")),
			);
			for (const pattern of [
				".env",
				".env.*",
				".dev.vars",
				".dev.vars.*",
				"tests",
				"docs",
				"release-assets",
				"reports",
			]) {
				assert.equal(excluded.has(pattern), true, `missing ${pattern}`);
			}
			for (const example of [
				"!.env.example",
				"!.env.docker.example",
				"!.dev.vars.example",
			]) {
				assert.equal(patterns.includes(example), true, `missing ${example}`);
			}
			assert.equal(
				patterns.indexOf("!.env.docker.example") > patterns.indexOf(".env.*"),
				true,
			);
			for (const dockerInput of [
				"package.json",
				"pnpm-lock.yaml",
				"pnpm-workspace.yaml",
				"tsconfig.json",
				"vitest.config.mjs",
				"wrangler.jsonc",
				"scripts",
				"src",
			]) {
				assert.equal(excluded.has(dockerInput), false, dockerInput);
			}
		},
	],
	[
		"keeps local environment secrets ignored while templates remain trackable",
		async () => {
			const patterns = (await readFile(".gitignore", "utf8"))
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#"));

			for (const pattern of [".env", ".env.*", ".dev.vars", ".dev.vars.*"]) {
				assert.equal(patterns.includes(pattern), true, `missing ${pattern}`);
			}
			for (const example of [
				"!.env.example",
				"!.env.docker.example",
				"!.dev.vars.example",
			]) {
				assert.equal(patterns.includes(example), true, `missing ${example}`);
			}
			assert.equal(
				patterns.indexOf("!.env.example") > patterns.indexOf(".env.*"),
				true,
			);
			assert.equal(
				patterns.indexOf("!.dev.vars.example") >
					patterns.indexOf(".dev.vars.*"),
				true,
			);
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
		"keeps Deploy Buttons pinned to the account-pool branch",
		async () => {
			for (const path of ["README.md", "README.zh.md"]) {
				const readme = await readFile(path, "utf8");
				const repositoryUrls = [
					...readme.matchAll(
						/https:\/\/deploy\.workers\.cloudflare\.com\/\?url=([^\s)]+)/g,
					),
				].map((match) => match[1]);
				assert.deepEqual(
					repositoryUrls,
					[DEPLOY_BUTTON_REPOSITORY, DEPLOY_BUTTON_REPOSITORY],
					path,
				);
			}
		},
	],
	[
		"keeps the Deploy Button config portable across fresh clones",
		async () => {
			const wrangler = parseJsoncObject(
				await readFile("wrangler.jsonc", "utf8"),
			);
			assert.equal(wrangler.main, "src/index.ts");
			assert.match(await readFile(wrangler.main, "utf8"), /export default/);
			const d1Bindings = wrangler.d1_databases || [];
			const geminiDb = d1Bindings.find(
				(binding) => binding.binding === "GEMINI_DB",
			);

			assert.equal(geminiDb?.database_name, "web2gem-gemini-accounts");
			assert.equal(Object.hasOwn(geminiDb || {}, "database_id"), false);

			const packageJson = JSON.parse(await readFile("package.json", "utf8"));
			assert.equal(
				packageJson.scripts["db:migrations:apply"],
				"wrangler d1 migrations apply GEMINI_DB --remote",
			);
		},
	],
	[
		"keeps true forks synchronized and Cloudflare-driven",
		async () => {
			const workflow = await readFile(
				".github/workflows/sync-upstream.yml",
				"utf8",
			);

			assert.match(workflow, /schedule:[\s\S]*cron: ["']0 0 \* \* 1["']/);
			assert.match(workflow, /workflow_dispatch:/);
			assert.match(workflow, /permissions:\s*\n\s+contents: write/);
			assert.match(workflow, /if: \$\{\{ github\.event\.repository\.fork \}\}/);
			assert.doesNotMatch(
				workflow,
				/reset --hard|push --force|-X theirs|CLOUDFLARE_API_TOKEN|database_id/,
			);
			assert.match(
				workflow,
				/uses: aormsby\/Fork-Sync-With-Upstream-action@v3\.4/,
			);
			assert.match(workflow, /upstream_sync_repo: Guardinary\/web2gem/);
			assert.match(workflow, /upstream_sync_branch: gemini-account-pool/);
			assert.match(workflow, /target_sync_branch: gemini-account-pool/);
			assert.match(
				workflow,
				/target_repo_token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/,
			);
			assert.match(workflow, /upstream_pull_args: ["']--ff-only["']/);
			assert.doesNotMatch(workflow, /\t/);
		},
	],
	[
		"keeps source quality workflows out of deployment copies",
		async () => {
			const workflow = await readFile(
				".github/workflows/quality-gates.yml",
				"utf8",
			);

			assert.match(
				workflow,
				/classify:[\s\S]*if: \$\{\{ github\.repository == 'Guardinary\/web2gem' \}\}/,
			);
			assert.match(
				workflow,
				/docker-smoke:[\s\S]*if: \$\{\{ github\.repository == 'Guardinary\/web2gem'/,
			);
		},
	],
	[
		"documents first deployment and automatic fork updates",
		async () => {
			const [english, chinese] = await Promise.all([
				readFile("README.md", "utf8"),
				readFile("README.zh.md", "utf8"),
			]);

			for (const [path, readme, patterns] of [
				[
					"README.md",
					english,
					[
						/first deployment only/i,
						/Recommended: automatic updates/,
						/Copy the main branch only/,
						/Upstream Sync/,
						/Workflow permissions/,
						/checks for updates every week/i,
						/Updating an existing Deploy Button clone/,
						/git merge --no-edit upstream\/gemini-account-pool/,
					],
				],
				[
					"README.zh.md",
					chinese,
					[
						/仅用于首次部署/,
						/推荐：自动更新部署/,
						/Copy the main branch only/,
						/Upstream Sync/,
						/Workflow permissions/,
						/每周会自动检查更新/,
						/更新已有的 Deploy Button clone/,
						/git merge --no-edit upstream\/gemini-account-pool/,
					],
				],
			]) {
				for (const pattern of patterns) assert.match(readme, pattern, path);
			}
		},
	],
	[
		"keeps README quality-command docs aligned with config",
		async () => {
			const [english, chinese, vitestConfig] = await Promise.all([
				readFile("README.md", "utf8"),
				readFile("README.zh.md", "utf8"),
				readFile("vitest.config.mjs", "utf8"),
			]);

			for (const readme of [english, chinese]) {
				for (const command of [
					"pnpm check:static",
					"pnpm check:worker-types",
					"pnpm typecheck",
					"pnpm check:arch",
					"pnpm unit",
					"pnpm coverage:ci",
					"pnpm smoke",
					"pnpm check:bench",
					"pnpm check:size",
					"pnpm docker:smoke",
				]) {
					assert.match(readme, new RegExp(command.replace(":", "\\:")));
				}
				assert.match(readme, /lcov/);
				assert.match(readme, /JSON summary/);
				assert.doesNotMatch(readme, /Vitest V8 text/);
			}
			assert.match(vitestConfig, /reporter:\s*\["lcov", "json-summary"\]/);
		},
	],
	[
		"keeps the account-pool release control plane on main",
		async () => {
			const packageJson = JSON.parse(await readFile("package.json", "utf8"));
			const runner = await readFile("scripts/check-release.mjs", "utf8");
			assert.equal(
				packageJson.scripts["check:release"],
				"node scripts/check-release.mjs",
			);
			for (const check of [
				"check:static",
				"check:worker-types",
				"typecheck",
				"check:arch",
				"coverage:ci",
				"smoke",
				"check:bench",
				"check:size",
			]) {
				assert.match(runner, new RegExp(`"${check.replace(":", "\\:")}"`));
			}

			for (const workflow of [
				".github/workflows/release.yml",
				".github/workflows/reusable-versioned-release.yml",
				".github/workflows/release-artifacts.yml",
				".github/workflows/release-main.yml",
				".github/workflows/release-account-pool.yml",
			]) {
				await assert.rejects(readFile(workflow, "utf8"), /ENOENT/, workflow);
			}

			const [english, chinese] = await Promise.all([
				readFile("README.md", "utf8"),
				readFile("README.zh.md", "utf8"),
			]);
			for (const readme of [english, chinese]) {
				assert.match(readme, /Release Account Pool Edition/);
				assert.match(readme, /pool-v\*/);
				assert.match(readme, /web2gem-account-pool-worker\.js/);
				assert.match(
					readme,
					/ghcr\.io\/guardinary\/web2gem-account-pool:latest/,
				);
			}
		},
	],
	[
		"keeps command runners centralized across quality scripts",
		async () => {
			const processHelper = await readFile("scripts/process.mjs", "utf8");
			assert.match(processHelper, /export function runPnpm/);
			assert.match(processHelper, /export function runCommand/);
			assert.match(processHelper, /export function outputCommand/);
			assert.match(processHelper, /export async function commandAvailable/);

			for (const path of [
				"scripts/unit.mjs",
				"scripts/coverage.mjs",
				"scripts/ensure-test-bundle-fresh.mjs",
				"scripts/docker-smoke.mjs",
				"scripts/check-release.mjs",
				"scripts/check-benchmark.mjs",
			]) {
				const source = await readFile(path, "utf8");
				assert.match(source, /from "\.\/process\.mjs"/, path);
				assert.doesNotMatch(source, /from "node:child_process"/, path);
			}
		},
	],
	[
		"keeps esbuild targets aligned with the TypeScript baseline",
		async () => {
			const tsconfig = JSON.parse(await readFile("tsconfig.json", "utf8"));
			const expectedTarget = String(
				tsconfig.compilerOptions.target,
			).toLowerCase();
			const buildScript = await readFile("scripts/build.mjs", "utf8");
			const adminBuildScript = await readFile(
				"scripts/build-admin-ui.mjs",
				"utf8",
			);

			assert.match(
				buildScript,
				new RegExp(`target:\\s*"${expectedTarget}"`),
				"scripts/build.mjs",
			);
			assert.match(
				adminBuildScript,
				new RegExp(`target:\\s*"${expectedTarget}"`),
				"scripts/build-admin-ui.mjs",
			);
		},
	],
	[
		"keeps generated Worker binding types aligned with runtime config",
		async () => {
			const packageJson = JSON.parse(await readFile("package.json", "utf8"));
			const generatedTypes = await readFile(
				"worker-configuration.d.ts",
				"utf8",
			);
			assert.match(
				packageJson.scripts["worker:types"],
				/^pnpm build && wrangler types/,
			);
			assert.match(
				packageJson.scripts["check:worker-types"],
				/^pnpm build && wrangler types/,
			);
			assert.match(generatedTypes, /interface WorkerBindings/);
			assert.match(generatedTypes, /GEMINI_DB:\s*D1Database/);
			for (const key of mod.CONFIG_ENV_KEYS) {
				assert.match(generatedTypes, new RegExp(`\\b${key}:`), key);
			}
		},
	],
	[
		"keeps static warnings blocking and account-pool branch gates required",
		async () => {
			const packageJson = JSON.parse(await readFile("package.json", "utf8"));
			const workflow = await readFile(
				".github/workflows/quality-gates.yml",
				"utf8",
			);
			assert.match(
				packageJson.scripts["check:static"],
				/--diagnostic-level=warn.*--error-on-warnings/,
			);
			assert.match(
				workflow,
				/branches:\s*\n\s+- dev\s*\n\s+- main\s*\n\s+- gemini-account-pool/,
			);
			assert.match(
				workflow,
				/github\.ref == 'refs\/heads\/gemini-account-pool'/,
			);
			assert.match(workflow, /name: Classify Change Risk/);
			assert.match(
				workflow,
				/git diff --name-only -z[\s\S]*node scripts\/classify-ci-changes\.mjs/,
			);
			assert.match(
				workflow,
				/name: Required Gates - Ubuntu[\s\S]*needs: classify/,
			);
			assert.match(
				workflow,
				/name: Required - Documentation Validation[\s\S]*git diff --check/,
			);
			assert.match(
				workflow,
				/name: Required Gates - Node Unit[\s\S]*if: \$\{\{ needs\.classify\.outputs\.runtime == 'true' \}\}/,
			);
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
		"src/admin-ui/logic.ts": coverageEntry(),
		"src/attachments/plan.ts": coverageEntry(),
		"src/completion/index.ts": coverageEntry(),
		"src/config/index.ts": coverageEntry(),
		"src/gemini/accounts/pool.ts": coverageEntry(),
		"src/gemini/app-page.ts": coverageEntry(),
		"src/gemini/completion-provider.ts": coverageEntry(),
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
	return new Promise((done) => {
		const args = arg == null ? [script] : [script, arg];
		execFile(
			process.execPath,
			args,
			{ cwd, env: { ...process.env, ...env } },
			(error, stdout, stderr) => {
				done({
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
