import { describe, test } from "vitest";
import { cases, suiteName } from "./docker-server.cases.mjs";

describe(suiteName, () => {
	for (const [name, runCase] of cases) test(name, runCase);
});
