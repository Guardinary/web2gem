import { runCommand, runPnpm } from "./process.mjs";

const vitestArgs = normalizeVitestArgs(process.argv.slice(2));

await runCommand(process.execPath, ["scripts/build.mjs", "--test-bundle"]);
await runPnpm(["exec", "vitest", "run", ...vitestArgs]);

function normalizeVitestArgs(args) {
	return args[0] === "--" ? args.slice(1) : args;
}
