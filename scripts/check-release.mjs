import { runPnpm } from "./process.mjs";

export const RELEASE_CHECKS = [
	"check:static",
	"check:test-types",
	"check:worker-types",
	"typecheck",
	"typecheck:tests",
	"check:arch",
	"coverage:ci",
	"smoke",
	"check:size",
];

for (const check of RELEASE_CHECKS) {
	await runPnpm([check]);
}
