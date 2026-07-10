import { spawn } from "node:child_process";

const vitestArgs = normalizeVitestArgs(process.argv.slice(2));

await run(process.execPath, ["scripts/build.mjs", "--test-bundle"]);
await runPnpm(["exec", "vitest", "run", ...vitestArgs]);

function normalizeVitestArgs(args) {
	return args[0] === "--" ? args.slice(1) : args;
}

function runPnpm(args) {
	if (process.env.npm_execpath) {
		if (/\.(?:c?js|mjs)$/i.test(process.env.npm_execpath)) {
			return run(process.execPath, [process.env.npm_execpath, ...args]);
		}
		return run(process.env.npm_execpath, args);
	}
	return run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args);
}

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: process.cwd(),
			env: process.env,
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
