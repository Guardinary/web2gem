// @ts-nocheck
import { describe, test } from "vitest";
import {
	base64DecodedByteLength,
	base64ToBytes,
	bytesToBase64,
	validateBase64Shape,
} from "../../../src/attachments/base64";
import { assert } from "../assertions.js";

async function withoutTypedArrayEncodingMethods(run) {
	const fromBase64Descriptor = Object.getOwnPropertyDescriptor(
		Uint8Array,
		"fromBase64",
	);
	const toBase64Descriptor = Object.getOwnPropertyDescriptor(
		Uint8Array.prototype,
		"toBase64",
	);
	Object.defineProperty(Uint8Array, "fromBase64", {
		value: undefined,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(Uint8Array.prototype, "toBase64", {
		value: undefined,
		configurable: true,
		writable: true,
	});
	try {
		return await run();
	} finally {
		if (fromBase64Descriptor) {
			Object.defineProperty(Uint8Array, "fromBase64", fromBase64Descriptor);
		} else {
			delete Uint8Array.fromBase64;
		}
		if (toBase64Descriptor) {
			Object.defineProperty(
				Uint8Array.prototype,
				"toBase64",
				toBase64Descriptor,
			);
		} else {
			delete Uint8Array.prototype.toBase64;
		}
	}
}

describe("attachment base64", () => {
	test("normalizes valid shapes and estimates decoded bytes", () => {
		assert.equal(validateBase64Shape(" aG Vs\nbG8= "), "aGVsbG8=");
		assert.equal(validateBase64Shape(""), "");
		assert.equal(base64DecodedByteLength("aGVsbG8="), 5);
		assert.equal(base64DecodedByteLength("-_8"), 2);
		assert.equal(base64DecodedByteLength(""), 0);
		for (const invalid of ["not base64!?", "a===", "aGV=sbG8", "A"]) {
			assert.throws(
				() => validateBase64Shape(invalid),
				/invalid base64 payload/,
			);
		}
	});

	test("decodes standard and URL-safe base64", () => {
		assert.deepEqual(
			Array.from(base64ToBytes("aGVsbG8")),
			[104, 101, 108, 108, 111],
		);
		assert.deepEqual(Array.from(base64ToBytes("-_8")), [251, 255]);
		for (const invalid of ["not base64!?", "a===", "aGV=sbG8", "A"]) {
			assert.throws(() => base64ToBytes(invalid), /invalid base64 payload/);
		}
	});

	test("round-trips bytes without TypedArray base64 helpers", async () => {
		await withoutTypedArrayEncodingMethods(async () => {
			const bytes = base64ToBytes("aGVsbG8");
			assert.deepEqual(Array.from(bytes), [104, 101, 108, 108, 111]);
			assert.equal(bytesToBase64(bytes), "aGVsbG8=");
			assert.deepEqual(Array.from(base64ToBytes("-_8")), [251, 255]);
			assert.throws(() => base64ToBytes("aGV=sbG8"), /invalid base64 payload/);
		});
	});
});
