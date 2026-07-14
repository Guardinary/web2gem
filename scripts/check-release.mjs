import { runPnpm } from "./process.mjs";

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
	await runPnpm([check]);
}
