import { spawn } from "node:child_process";

const ci = process.argv.includes("--ci");
const coverageBuildDir = "dist-coverage";

await runPnpm(["build"], {
	...process.env,
	BUILD_DIR: coverageBuildDir,
	BUILD_TEST_BUNDLE: "1",
	COVERAGE: "1",
});

await runPnpm(["exec", "vitest", "run", "--coverage"], {
	...process.env,
	TEST_BUNDLE: `../../${coverageBuildDir}/worker.test.js`,
	BENCH_TEST_BUNDLE: `${coverageBuildDir}/worker.test.js`,
});

if (ci) {
	await run(process.execPath, ["scripts/check-coverage.mjs"], process.env);
}

function runPnpm(args, env) {
	if (process.env.npm_execpath) {
		if (/\.(?:c?js|mjs)$/i.test(process.env.npm_execpath)) {
			return run(process.execPath, [process.env.npm_execpath, ...args], env);
		}
		return run(process.env.npm_execpath, args, env);
	}
	const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
	return run(command, args, env);
}

function run(command, args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: process.cwd(),
			env,
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			const suffix = signal ? `signal ${signal}` : `exit code ${code}`;
			reject(new Error(`${command} ${args.join(" ")} failed with ${suffix}`));
		});
	});
}
