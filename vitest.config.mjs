import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			reportsDirectory: "coverage",
			reporter: ["lcov", "json-summary"],
			include: ["dist-coverage/worker.test.js"],
			exclude: ["dist-coverage/worker.js", "src/test-index.ts"],
		},
		environment: "node",
		fileParallelism: true,
		include: ["tests/unit/*.test.mjs"],
		testTimeout: 30000,
	},
});
