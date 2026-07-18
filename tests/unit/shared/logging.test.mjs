import { describe, test } from "vitest";
import { log, logStage } from "../../../src/shared/logging";
import { assert } from "../assertions.js";
import { withConsoleLog } from "../_support/globals.js";

describe("shared logging", () => {
	test.sequential("logs runtime messages and stage metadata behind config flag", async () => {
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			async () => {
				log(null, "hidden");
				log({ log_requests: false }, "hidden");
				log({ log_requests: true }, { ok: true });
				const cyclic = {};
				cyclic.self = cyclic;
				log({ log_requests: true }, cyclic);
				logStage({ log_requests: true }, "upload", {
					empty: "",
					skip: null,
					n: 0,
					ok: false,
					name: "message.txt",
				});
				logStage(null, "hidden");
			},
		);
		assert.equal(logs.length, 3);
		assert.match(logs[0], /\[web2gem\] \{"ok":true\}/);
		assert.match(logs[1], /\[object Object\]/);
		assert.match(logs[2], /stage=upload/);
		assert.match(logs[2], /n=0/);
		assert.match(logs[2], /ok=false/);
		assert.match(logs[2], /name=message\.txt/);
		assert.doesNotMatch(logs[2], /empty=/);
		await withConsoleLog(
			() => {
				throw new Error("console unavailable");
			},
			async () => {
				log({ log_requests: true }, "safe");
			},
		);
	});
});
