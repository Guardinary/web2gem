import { spawnSync } from "node:child_process";

export const RELEASE_CHECKS = [
	"check:static",
	"check:worker-types",
	"typecheck",
	"check:arch",
	"coverage:ci",
	"smoke",
	"check:bench",
	"check:size",
];

for (const check of RELEASE_CHECKS) {
	const result = spawnSync("pnpm", [check], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
