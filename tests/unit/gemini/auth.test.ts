// @ts-nocheck
import { describe, test } from "vitest";
import { _sapisidHashCache, makeSapisidHash } from "../../../src/gemini/auth";
import { assert } from "../assertions.js";
import { withPatchedGlobal } from "../_support/globals.js";

describe("Gemini SAPISID authorization", () => {
	test.sequential("builds and caches SAPISIDHASH authorization headers", async () => {
		const cacheSnapshot = { ..._sapisidHashCache };
		_sapisidHashCache.key = "";
		_sapisidHashCache.value = "";
		const originalNow = Date.now;
		Date.now = () => 1_700_000_000_000;
		let digestCalls = 0;
		let digestInput = "";
		try {
			await withPatchedGlobal(
				"crypto",
				{
					subtle: {
						async digest(algorithm, data) {
							digestCalls++;
							assert.equal(algorithm, "SHA-1");
							digestInput = new TextDecoder().decode(data);
							const bytes = new Uint8Array(20);
							bytes[0] = 0xab;
							bytes[19] = 0xcd;
							return bytes.buffer;
						},
					},
				},
				async () => {
					const first = await makeSapisidHash("sapi-cache-test");
					const second = await makeSapisidHash("sapi-cache-test");
					assert.equal(
						first,
						"SAPISIDHASH 1700000000_ab000000000000000000000000000000000000cd",
					);
					assert.equal(second, first);
					assert.equal(digestCalls, 1);
					assert.equal(
						digestInput,
						"1700000000 sapi-cache-test https://gemini.google.com",
					);
				},
			);
		} finally {
			Date.now = originalNow;
			_sapisidHashCache.key = cacheSnapshot.key;
			_sapisidHashCache.value = cacheSnapshot.value;
		}
	});
});
