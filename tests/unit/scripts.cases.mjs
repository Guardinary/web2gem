import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "./assertions.js";
import { mod } from "./helpers.js";

export const suiteName = "quality scripts";
export const cases = [
  ["accepts coverage summaries that satisfy line and branch gates", async () => {
    await withCoverageSummary(fullCoverageSummary(), async (summaryPath) => {
      const result = await runNodeScript("scripts/check-coverage.mjs", summaryPath);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /Coverage gates passed/);
    });
  }],
  ["rejects coverage summaries below branch gates", async () => {
    const summary = fullCoverageSummary();
    summary["src/toolcall/structured.ts"].branches.covered = 54;
    await withCoverageSummary(summary, async (summaryPath) => {
      const result = await runNodeScript("scripts/check-coverage.mjs", summaryPath);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Coverage gate failed/);
      assert.match(result.stderr, /src\/toolcall\/structured\.ts/);
    });
  }],
  ["rejects missing coverage data for required targets", async () => {
    const summary = fullCoverageSummary();
    delete summary["src/http/openai/responses-stream.ts"];
    await withCoverageSummary(summary, async (summaryPath) => {
      const result = await runNodeScript("scripts/check-coverage.mjs", summaryPath);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /missing lines coverage data/);
      assert.match(result.stderr, /responses-stream\.ts/);
    });
  }],
  ["accepts bundle size within the configured budget", async () => {
    await withTempFile("worker.js", "x".repeat(128), async (bundlePath) => {
      const result = await runNodeScript("scripts/check-bundle-size.mjs", bundlePath, {
        BUNDLE_SIZE_LIMIT_BYTES: "256",
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /bundle size ok/);
    });
  }],
  ["rejects bundle size over the configured budget", async () => {
    await withTempFile("worker.js", "x".repeat(257), async (bundlePath) => {
      const result = await runNodeScript("scripts/check-bundle-size.mjs", bundlePath, {
        BUNDLE_SIZE_LIMIT_BYTES: "256",
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Bundle size gate failed/);
    });
  }],
  ["accepts benchmark medians within the configured budget", async () => {
    await withTempFile("bench.txt", "stream_sieve_held_tool          n=20  median=12.500ms  p95=13.000ms\n", async (benchPath) => {
      const result = await runNodeScript("scripts/check-benchmark.mjs", benchPath, {
        BENCH_MAX_MEDIAN_MS: "20",
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /benchmark gate ok/);
    });
  }],
  ["rejects benchmark medians over the configured budget", async () => {
    await withTempFile("bench.txt", "stream_sieve_held_tool          n=20  median=25.000ms  p95=26.000ms\n", async (benchPath) => {
      const result = await runNodeScript("scripts/check-benchmark.mjs", benchPath, {
        BENCH_MAX_MEDIAN_MS: "20",
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Benchmark gate failed/);
    });
  }],
  ["parses microsecond benchmark output for the performance gate", async () => {
    await withTempFile("bench.txt", "stream_sieve_held_tool          n=20  median=850.0us  p95=900.0us\n", async (benchPath) => {
      const result = await runNodeScript("scripts/check-benchmark.mjs", benchPath, {
        BENCH_MAX_MEDIAN_MS: "1",
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /850\.0us <= 1\.000ms/);
    });
  }],
  ["skips Docker smoke when Docker is not installed", async () => {
    await withTempDir(async (dir) => {
      const result = await runNodeScript("scripts/docker-smoke.mjs", null, {
        PATH: dir,
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /Docker smoke skipped: docker executable not found/);
    });
  }],
  ["keeps Docker Compose port mapping aligned with the container listener", async () => {
    const compose = await readFile("compose.yaml", "utf8");
    assert.match(compose, /\$\{PORT:-52389\}:\$\{PORT:-52389\}/);
    assert.doesNotMatch(compose, /\$\{PORT:-52389\}:52389/);
  }],
  ["keeps runtime config env keys aligned with Docker docs and Compose", async () => {
    const envExample = parseEnvExampleKeys(await readFile(".env.example", "utf8"));
    const composeEnv = parseComposeEnvironmentKeys(await readFile("compose.yaml", "utf8"));
    const internalCompatKeys = new Set(["GEMINI_COOKIE", "SAPISID"]);
    const configKeys = mod.CONFIG_ENV_KEYS.filter((key) => !internalCompatKeys.has(key));

    assert.deepEqual(missingKeys(configKeys, envExample), []);
    assert.deepEqual(missingKeys(configKeys, composeEnv), []);
  }],
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
    "src/completion/index.ts": coverageEntry(),
    "src/config/index.ts": coverageEntry(),
    "src/gemini/app-page.ts": coverageEntry(),
    "src/gemini/index.ts": coverageEntry(),
    "src/gemini/client/index.ts": coverageEntry(),
    "src/gemini/client/parser.ts": coverageEntry(),
    "src/gemini/transport/http.ts": coverageEntry(),
    "src/gemini/uploads/index.ts": coverageEntry(),
    "src/http/core/json.ts": coverageEntry(),
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

function runNodeScript(script, arg, env = {}) {
  return new Promise((resolve) => {
    const args = arg == null ? [script] : [script, arg];
    execFile(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
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

function missingKeys(expected, actual) {
  return expected.filter((key) => !actual.has(key));
}
