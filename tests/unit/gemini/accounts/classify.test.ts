// @ts-nocheck
import { describe, test } from "vitest";
import { classifyGeminiAccountOutcome } from "../../../../src/gemini/accounts/classify";
import { assert } from "../../assertions.js";

describe("Gemini account outcome classification", () => {
	test("maps authentication and rate-limit responses to recoverable health failures", () => {
		assert.deepEqual(classifyGeminiAccountOutcome({ status: 401 }, 1000), {
			kind: "failure",
			issue: "auth",
			recoveryScope: "try_next_account",
			nowMs: 1000,
		});
		assert.deepEqual(classifyGeminiAccountOutcome({ status: 429 }, 1000), {
			kind: "failure",
			issue: "rate_limit",
			cooldownUntilMs: 301000,
			recoveryScope: "try_next_account",
			nowMs: 1000,
		});
	});

	test("maps transport failures to a temporary recoverable issue", () => {
		assert.deepEqual(
			classifyGeminiAccountOutcome(new Error("network reset"), 1000),
			{
				kind: "failure",
				issue: "transient",
				cooldownUntilMs: 61000,
				recoveryScope: "try_next_account",
				nowMs: 1000,
			},
		);
	});

	test("keeps model, missing-route, and replay failures terminal without an account issue", () => {
		for (const error of [
			new Error("invalid model"),
			{ code: "gemini_route_not_selected" },
			{ code: "gemini_upload_replay_failed" },
		]) {
			assert.deepEqual(classifyGeminiAccountOutcome(error, 1000), {
				kind: "failure",
				recoveryScope: "none",
				nowMs: 1000,
			});
		}
	});

	test("distinguishes recoverable and terminal stream semantic errors", () => {
		assert.deepEqual(
			classifyGeminiAccountOutcome(
				{
					code: "gemini_semantic_error",
					geminiSource: "stream_generate",
					geminiCode: "1050",
				},
				1000,
			),
			{
				kind: "failure",
				recoveryScope: "try_next_account",
				nowMs: 1000,
			},
		);
		assert.deepEqual(
			classifyGeminiAccountOutcome(
				{
					code: "gemini_semantic_error",
					geminiSource: "stream_generate",
					geminiCode: "1060",
				},
				1000,
			),
			{ kind: "failure", recoveryScope: "none", nowMs: 1000 },
		);
	});

	test("maps restricted account status to a terminal location issue", () => {
		assert.deepEqual(
			classifyGeminiAccountOutcome(
				{ geminiSource: "account_status", geminiCode: "1060" },
				1000,
			),
			{
				kind: "failure",
				issue: "location",
				recoveryScope: "none",
				nowMs: 1000,
			},
		);
	});
});
