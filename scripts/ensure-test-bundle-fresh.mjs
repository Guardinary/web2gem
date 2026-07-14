import { existsSync, globSync, statSync } from "node:fs";
import { runCommand } from "./process.mjs";

const bundlePaths = ["dist/worker.test.js", "dist/worker.js"];
const sourceGlobs = [
	"src/**/*.ts",
	"scripts/build.mjs",
	"package.json",
	"tsconfig.json",
];

if (needsBuild()) {
	await runCommand(process.execPath, ["scripts/build.mjs", "--test-bundle"]);
}

function needsBuild() {
	if (bundlePaths.some((path) => !existsSync(path))) return true;

	const oldestBundleMtime = Math.min(
		...bundlePaths.map((path) => statSync(path).mtimeMs),
	);

	for (const pattern of sourceGlobs) {
		for (const path of globSync(pattern)) {
			if (statSync(path).mtimeMs > oldestBundleMtime) return true;
		}
	}
	return false;
}
