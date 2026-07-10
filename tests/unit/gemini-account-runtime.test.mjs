import { describe, test } from "vitest";
import { cases, suiteName } from "./gemini-account-runtime.cases.mjs";

describe(suiteName, () => {
	for (const [name, runCase] of cases) test(name, runCase);
});
