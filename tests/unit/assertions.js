import { expect } from "vitest";

function assertionFor(actual, message) {
	return message === undefined ? expect(actual) : expect(actual, message);
}

function rejectedValue(input) {
	if (typeof input !== "function") return input;
	try {
		return input();
	} catch (err) {
		return Promise.reject(err);
	}
}

export function equal(actual, expected, message) {
	assertionFor(actual, message).toBe(expected);
}

export function deepEqual(actual, expected, message) {
	assertionFor(actual, message).toEqual(expected);
}

export function match(actual, expected, message) {
	assertionFor(actual, message).toMatch(expected);
}

export function doesNotMatch(actual, expected, message) {
	assertionFor(actual, message).not.toMatch(expected);
}

export async function rejects(input, expected, message) {
	const assertion = assertionFor(rejectedValue(input), message).rejects;
	if (expected === undefined) {
		await assertion.toThrow();
	} else {
		await assertion.toThrow(expected);
	}
}

export function throws(input, expected, message) {
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
