import { defineConfig } from "vitest/config";
import { buildAdminUi } from "./scripts/build-admin-ui.mjs";

const { html: adminUiHtml } = await buildAdminUi();

export default defineConfig({
	define: {
		__WEB2GEM_ADMIN_UI_HTML__: JSON.stringify(adminUiHtml),
	},
	test: {
		coverage: {
			provider: "v8",
			reportsDirectory: "coverage",
			reporter: ["lcov", "json-summary"],
			all: true,
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: [
				"src/harness-exports.ts",
				// Preact view modules ship in the browser admin-ui bundle and are
				// exercised there; the unit suite covers admin-ui logic modules only
				// (same scope the old test-bundle tree-shaking implied).
				"src/admin-ui/main.tsx",
				"src/admin-ui/app.tsx",
				"src/admin-ui/components/**",
				"src/admin-ui/sections/**",
				"src/admin-ui/icons.tsx",
			],
		},
		environment: "node",
		fileParallelism: true,
		include: ["tests/unit/**/*.test.{ts,tsx}"],
		pool: "threads",
		testTimeout: 30000,
	},
});
