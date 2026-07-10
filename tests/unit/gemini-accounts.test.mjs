import { describe, test } from "vitest";
import { cases, suiteName } from "./gemini-accounts.cases.mjs";

describe(suiteName, () => {
	for (const [name, runCase] of cases) test(name, runCase);
});
