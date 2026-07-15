import { runCommand, runPnpm } from "./process.mjs";

const ci = process.argv.includes("--ci");

await runPnpm(["exec", "vitest", "run", "--coverage"]);

if (ci) {
	await runCommand(process.execPath, ["scripts/check-coverage.mjs"]);
}
