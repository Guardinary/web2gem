import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assert } from "./assertions.js";
import { mod } from "./helpers.js";

const DEPLOY_SECRET_TEMPLATE_KEYS = ["API_KEYS", "GEMINI_COOKIE", "SAPISID"];
const DEPLOY_SECRET_KEYS = new Set(DEPLOY_SECRET_TEMPLATE_KEYS);
const DOCKER_ONLY_ENV_KEYS = ["PORT", "WEB2GEM_IMAGE"];

export const suiteName = "quality scripts";
export const cases = [
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
			delete summary["src/gemini/client/parser.ts"];
			await withCoverageSummary(summary, async (summaryPath) => {
				const result = await runNodeScript(
					"scripts/check-coverage.mjs",
					summaryPath,
				);
				assert.equal(result.code, 1);
				assert.match(result.stderr, /missing (?:lines|branches) coverage data/);
				assert.match(result.stderr, /src\/gemini\/client\/parser\.ts/);
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
				[["tests/unit/scripts.test.mjs"], "runtime"],
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
			assert.match(compose, /\$\{PORT:-52389\}:\$\{PORT:-52389\}/);
			assert.doesNotMatch(compose, /\$\{PORT:-52389\}:52389/);
			assert.match(
				compose,
				/REQUEST_BODY_MAX_BYTES:\s*"\$\{REQUEST_BODY_MAX_BYTES:-16777216\}"/,
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
			assert.deepEqual(runtimeImports.sort(), []);
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
			const dockerignore = await readFile(".dockerignore", "utf8");
			const patterns = dockerignore
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
			for (const example of ["!.env.example", "!.dev.vars.example"]) {
				assert.equal(patterns.includes(example), true, `missing ${example}`);
			}
			assert.equal(
				patterns.indexOf("!.env.example") > patterns.indexOf(".env.*"),
				true,
				".env.example must be re-included after the wildcard exclusion",
			);
			assert.equal(
				patterns.indexOf("!.dev.vars.example") >
					patterns.indexOf(".dev.vars.*"),
				true,
				".dev.vars.example must be re-included after the wildcard exclusion",
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
			for (const example of ["!.env.example", "!.dev.vars.example"]) {
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
				await readFile(".env.example", "utf8"),
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
			const deploySecretTemplates = [".dev.vars.example"];
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
		"keeps edition releases isolated behind the main-branch control plane",
		async () => {
			const packageJson = JSON.parse(await readFile("package.json", "utf8"));
			const runner = await readFile("scripts/check-release.mjs", "utf8");
			const [releaseArtifacts, versionedRelease, mainRelease, poolRelease] =
				await Promise.all([
					readFile(".github/workflows/release-artifacts.yml", "utf8"),
					readFile(".github/workflows/reusable-versioned-release.yml", "utf8"),
					readFile(".github/workflows/release-main.yml", "utf8"),
					readFile(".github/workflows/release-account-pool.yml", "utf8"),
				]);
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
			for (const workflow of [releaseArtifacts, versionedRelease]) {
				assert.match(workflow, /pnpm check:release\s+pnpm docker:smoke/);
				assert.doesNotMatch(workflow, /pnpm coverage:ci/);
				assert.doesNotMatch(workflow, /\t/);
			}
			const sourceGuard = versionedRelease.indexOf(
				"- name: Validate release source and edition",
			);
			const checkout = versionedRelease.indexOf(
				"- name: Checkout release branch",
			);
			const install = versionedRelease.indexOf("- name: Install dependencies");
			assert.equal(
				sourceGuard >= 0,
				true,
				"versioned release source guard is missing",
			);
			assert.equal(
				sourceGuard < checkout && checkout < install,
				true,
				"release source must be validated before checkout and dependency install",
			);
			assert.match(
				versionedRelease,
				/RELEASE_REF: \$\{\{ github\.ref \}\}[\s\S]*?"refs\/heads\/main"/,
			);
			assert.match(
				versionedRelease,
				/ref: \$\{\{ inputs\.source_branch \}\}\s+fetch-depth: 0/,
			);
			assert.match(
				versionedRelease,
				/git tag --list "\$\{TAG_PREFIX\}\[0-9\]\*"/,
			);
			assert.doesNotMatch(versionedRelease, /git describe --tags/);
			assert.match(
				versionedRelease,
				/git push --atomic origin "HEAD:\$\{SOURCE_BRANCH\}" "refs\/tags\/\$\{NEW_TAG\}"/,
			);

			for (const [workflow, expected] of [
				[
					mainRelease,
					{
						edition: "main",
						branch: "main",
						tagPrefix: "v",
						assetPrefix: "web2gem-main",
						imageRepository: "web2gem",
					},
				],
				[
					poolRelease,
					{
						edition: "account-pool",
						branch: "gemini-account-pool",
						tagPrefix: "pool-v",
						assetPrefix: "web2gem-account-pool",
						imageRepository: "web2gem-account-pool",
					},
				],
			]) {
				assert.match(
					workflow,
					/uses: \.\/\.github\/workflows\/reusable-versioned-release\.yml[\s\S]*uses: \.\/\.github\/workflows\/release-artifacts\.yml/,
				);
				assert.match(workflow, new RegExp(`edition: ${expected.edition}`));
				assert.match(workflow, new RegExp(`source_branch: ${expected.branch}`));
				assert.match(
					workflow,
					new RegExp(`tag_prefix: ${expected.tagPrefix}(?:\\n|$)`),
				);
				assert.match(
					workflow,
					new RegExp(`asset_prefix: ${expected.assetPrefix}`),
				);
				assert.match(
					workflow,
					new RegExp(`image_repository: ${expected.imageRepository}`),
				);
				assert.match(workflow, /group: versioned-release/);
				assert.doesNotMatch(workflow, /docker\/build-push-action/);
			}

			assert.match(releaseArtifacts, /workflow_call:/);
			assert.doesNotMatch(
				releaseArtifacts,
				/workflow_dispatch:|\n {2}release:/,
			);
			assert.match(
				releaseArtifacts,
				/edition:[\s\S]*tag_prefix:[\s\S]*asset_prefix:[\s\S]*image_repository:[\s\S]*release_tag:[\s\S]*revision_sha:/,
			);
			assert.equal(
				[...releaseArtifacts.matchAll(/uses: docker\/build-push-action@v6/g)]
					.length,
				1,
				"release publication should have one multi-registry image build",
			);
			assert.match(
				releaseArtifacts,
				/tags: \$\{\{ steps\.image_tags\.outputs\.tags \}\}/,
			);
			assert.match(
				releaseArtifacts,
				/cache-from: type=gha,scope=\$\{\{ env\.RELEASE_CACHE_SCOPE \}\}[\s\S]*cache-to: type=gha,mode=max,scope=\$\{\{ env\.RELEASE_CACHE_SCOPE \}\}/,
			);
			assert.match(
				releaseArtifacts,
				/RELEASE_CACHE_SCOPE: release-image-\$\{\{ inputs\.edition \}\}/,
			);
			assert.match(
				releaseArtifacts,
				/ghcr\.io\/\$\{ghcr_owner\}\/\$\{IMAGE_REPOSITORY\}/,
			);
			assert.match(
				releaseArtifacts,
				/release-assets\/\$\{ASSET_PREFIX\}-worker\.js/,
			);
			await assert.rejects(
				readFile(".github/workflows/release.yml", "utf8"),
				/ENOENT/,
			);
			await assert.rejects(
				readFile(".github/workflows/release-dockerhub.yml", "utf8"),
				/ENOENT/,
			);
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

			assert.match(
				buildScript,
				new RegExp(`target:\\s*"${expectedTarget}"`),
				"scripts/build.mjs",
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
			assert.doesNotMatch(
				generatedTypes,
				/\b[A-Z][A-Z0-9_]*_DB\b|interface D1/,
			);
			for (const key of mod.CONFIG_ENV_KEYS) {
				assert.match(generatedTypes, new RegExp(`\\b${key}:`), key);
			}
		},
	],
	[
		"keeps static warnings blocking and portable branch gates required",
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
				/branches:\s*\n\s+- dev\s*\n\s+- main\s*\n\s*workflow_dispatch:/,
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
