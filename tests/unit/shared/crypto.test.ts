import { describe, test } from "vitest";
import { randHex, uuid } from "../../../src/shared/crypto";
import { assert } from "../assertions.js";
import { withPatchedGlobal } from "../_support/globals.js";

async function withoutTypedArrayHexMethod<T>(
	run: () => T | PromiseLike<T>,
): Promise<T> {
	const toHexDescriptor = Object.getOwnPropertyDescriptor(
		Uint8Array.prototype,
		"toHex",
	);
	Object.defineProperty(Uint8Array.prototype, "toHex", {
		value: undefined,
		configurable: true,
		writable: true,
	});
	try {
		return await run();
	} finally {
		if (toHexDescriptor)
			Object.defineProperty(Uint8Array.prototype, "toHex", toHexDescriptor);
		else Reflect.deleteProperty(Uint8Array.prototype, "toHex");
	}
}

describe("shared crypto primitives", () => {
	test.sequential("generates runtime ids through native crypto paths", async () => {
		await withPatchedGlobal(
			"crypto",
			{
				getRandomValues(arr: Uint8Array): Uint8Array {
					for (let i = 0; i < arr.length; i++) arr[i] = 0xab + i;
					return arr;
				},
				randomUUID() {
					return "native-uuid";
				},
			},
			async () => {
				await withoutTypedArrayHexMethod(async () => {
					assert.equal(randHex(5), "abaca");
					assert.equal(randHex(6), "abacad");
				});
				assert.equal(uuid(), "native-uuid");
			},
		);
	});
});
