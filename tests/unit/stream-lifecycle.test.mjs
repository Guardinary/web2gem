import { beforeEach, describe, test } from "vitest";
import { cases, suiteName } from "./stream-lifecycle.cases.mjs";
import { resetTestState } from "./helpers.js";

describe(suiteName, () => {
	beforeEach(resetTestState);
	for (const [name, runCase] of cases) test(name, runCase);
});
