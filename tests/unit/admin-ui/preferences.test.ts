// @ts-nocheck
import { describe, test } from "vitest";
import { detectLanguage } from "../../../src/admin-ui/i18n";
import { resolveTheme } from "../../../src/admin-ui/theme";
import { assert } from "../assertions.js";

describe("admin UI preferences", () => {
	test("resolves language and theme preferences without browser state", () => {
		assert.equal(detectLanguage("zh-CN"), "zh-CN");
		assert.equal(detectLanguage("en-US"), "en");
		assert.equal(resolveTheme("system", true), "dark");
		assert.equal(resolveTheme("system", false), "light");
		assert.equal(resolveTheme("light", true), "light");
	});
});
