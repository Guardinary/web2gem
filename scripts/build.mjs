import esbuild from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { buildAdminUi } from "./build-admin-ui.mjs";

await buildAdminUi();

const coverageBuild = /^(1|true|yes|on)$/i.test(process.env.COVERAGE || "");
const includeTestBundle =
	process.argv.includes("--test-bundle") ||
	/^(1|true|yes|on)$/i.test(process.env.BUILD_TEST_BUNDLE || "");
const outDir =
	process.env.BUILD_DIR || (coverageBuild ? "dist-coverage" : "dist");

if (coverageBuild) {
	await rm(outDir, { recursive: true, force: true });
}

await mkdir(outDir, { recursive: true });

if (!coverageBuild) {
	await Promise.all([
		rm(`${outDir}/worker.js.map`, { force: true }),
		rm(`${outDir}/worker.test.js`, { force: true }),
		rm(`${outDir}/worker.test.js.map`, { force: true }),
	]);
}

const common = {
	bundle: true,
	format: "esm",
	target: "es2025",
	platform: "browser",
	sourcemap: coverageBuild ? "linked" : false,
	sourcesContent: coverageBuild,
	legalComments: "none",
	external: ["cloudflare:sockets"],
	logLevel: "info",
};

await esbuild.build({
	...common,
	entryPoints: ["src/index.ts"],
	outfile: `${outDir}/worker.js`,
});

if (includeTestBundle || coverageBuild) {
	await esbuild.build({
		...common,
		entryPoints: ["src/test-index.ts"],
		outfile: `${outDir}/worker.test.js`,
	});
}
