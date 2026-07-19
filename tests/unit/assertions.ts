import { expect } from "vitest";

function assertionFor(actual: unknown, message?: string) {
	return message === undefined ? expect(actual) : expect(actual, message);
}

function rejectedValue(input: unknown): unknown {
	if (typeof input !== "function") return input;
	try {
		return input();
	} catch (err) {
		return Promise.reject(err);
	}
}

export function equal(actual: unknown, expected: unknown, message?: string) {
	assertionFor(actual, message).toBe(expected);
}

export function deepEqual(
	actual: unknown,
	expected: unknown,
	message?: string,
) {
	assertionFor(actual, message).toEqual(expected);
}

export function match(actual: unknown, expected: RegExp, message?: string) {
	assertionFor(actual, message).toMatch(expected);
}

export function doesNotMatch(
	actual: unknown,
	expected: RegExp,
	message?: string,
) {
	assertionFor(actual, message).not.toMatch(expected);
}

export async function rejects(
	input: unknown,
	expected?: RegExp | string | Error,
	message?: string,
) {
	const assertion = assertionFor(rejectedValue(input), message).rejects;
	if (expected === undefined) {
		await assertion.toThrow();
	} else {
		await assertion.toThrow(expected);
	}
}

export function throws(
	input: () => unknown,
	expected?: RegExp | string | Error,
	message?: string,
) {
	const assertion = assertionFor(input, message);
	if (expected === undefined) assertion.toThrow();
	else assertion.toThrow(expected);
}

export const assert = {
	deepEqual,
	doesNotMatch,
	equal,
	match,
	rejects,
	throws,
};
