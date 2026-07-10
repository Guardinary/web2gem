import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			reportsDirectory: "coverage",
			reporter: ["text", "lcov", "json-summary"],
			include: ["dist-coverage/worker.test.js"],
			exclude: ["dist-coverage/worker.js", "src/test-index.ts"],
			thresholds: {
				statements: 88,
				branches: 75,
				functions: 90,
				lines: 90,
			},
		},
		environment: "node",
		fileParallelism: true,
		include: ["tests/unit/*.test.mjs"],
		testTimeout: 30000,
	},
});
