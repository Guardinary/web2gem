import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			reportsDirectory: "coverage",
			reporter: ["lcov", "json-summary"],
			all: true,
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: [
				"src/generated/**",
				"src/harness-exports.ts",
				"src/public-exports.ts",
			],
		},
		environment: "node",
		fileParallelism: true,
		include: ["tests/unit/*.test.mjs"],
		testTimeout: 30000,
	},
});
