import { spawn } from "node:child_process";

export function runPnpm(args, options = {}) {
	const env = options.env || process.env;
	const npmExecPath = env.npm_execpath || process.env.npm_execpath;
	if (npmExecPath) {
		if (/\.(?:c?js|mjs)$/i.test(npmExecPath)) {
			return runCommand(process.execPath, [npmExecPath, ...args], options);
		}
		return runCommand(npmExecPath, args, options);
	}
	return runCommand(
		process.platform === "win32" ? "pnpm.cmd" : "pnpm",
		args,
		options,
	);
}

export function runCommand(command, args, options = {}) {
	return spawnCommand(command, args, {
		...options,
		stdio: options.stdio || "inherit",
	});
}

export function outputCommand(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd || process.cwd(),
			env: options.env || process.env,
			stdio: ["ignore", "pipe", options.allowFailure ? "ignore" : "inherit"],
		});
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0 || options.allowFailure) {
				resolve(stdout);
				return;
			}
			reject(commandFailure(command, args, code, signal));
		});
	});
}

export async function commandAvailable(command) {
	try {
		await outputCommand(command, ["--version"], { allowFailure: true });
		return true;
	} catch (error) {
		return !isMissingExecutableError(error);
	}
}

function spawnCommand(command, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd || process.cwd(),
			env: options.env || process.env,
			stdio: options.stdio,
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0 || options.allowFailure) {
				resolve({ code, signal });
				return;
			}
			reject(commandFailure(command, args, code, signal));
		});
	});
}

function commandFailure(command, args, code, signal) {
	const suffix = signal ? `signal ${signal}` : `exit code ${code}`;
	return new Error(`${command} ${args.join(" ")} failed with ${suffix}`);
}

function isMissingExecutableError(error) {
	return (
		error &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
