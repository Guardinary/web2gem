import { runCommand, runPnpm } from "./process.mjs";

const ci = process.argv.includes("--ci");
const coverageBuildDir = "dist-coverage";

await runPnpm(["build"], {
	env: {
		...process.env,
		BUILD_DIR: coverageBuildDir,
		BUILD_TEST_BUNDLE: "1",
		COVERAGE: "1",
	},
});

await runPnpm(["exec", "vitest", "run", "--coverage"], {
	env: {
		...process.env,
		TEST_BUNDLE: `../../${coverageBuildDir}/worker.test.js`,
		BENCH_TEST_BUNDLE: `${coverageBuildDir}/worker.test.js`,
	},
});

if (ci) {
	await runCommand(process.execPath, ["scripts/check-coverage.mjs"]);
}
