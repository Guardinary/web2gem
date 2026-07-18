import { describe, test } from "vitest";
import {
	createAccount,
	createAccounts,
	createAccountsWithLimitFallback,
} from "../../../src/admin-ui/api";
import { assert } from "../assertions.js";
import { withAdminFetch } from "./_support/environment.js";
import {
	uiAdminApiSession,
	uiImportBatch,
	uiMutation,
} from "./_support/fixtures.js";

describe("admin UI import API", () => {
	test("serializes single and batch credentials without empty labels", async () => {
		const requests = [];
		const session = uiAdminApiSession();
		await withAdminFetch(
			async (path, init = {}) => {
				requests.push({ path, init });
				return Response.json(uiMutation());
			},
			async () => {
				await createAccount(session, {
					label: "",
					psid: "psid-one",
					psidts: "psidts-one",
				});
				await createAccounts(session, {
					accounts: [
						{ psid: "psid-two", psidts: "psidts-two", label: "Second" },
					],
				});
			},
		);

		assert.deepEqual(
			requests.map(({ path, init }) => ({
				path,
				method: init.method,
				body: JSON.parse(init.body),
				signal: init.signal,
				authorization: init.headers.Authorization,
			})),
			[
				{
					path: "/admin/accounts",
					method: "POST",
					body: {
						provider: "gemini",
						"__Secure-1PSID": "psid-one",
						"__Secure-1PSIDTS": "psidts-one",
					},
					signal: session.signal,
					authorization: "Bearer admin-secret",
				},
				{
					path: "/admin/accounts",
					method: "POST",
					body: {
						provider: "gemini",
						accounts: [
							{
								provider: "gemini",
								"__Secure-1PSID": "psid-two",
								"__Secure-1PSIDTS": "psidts-two",
								label: "Second",
							},
						],
					},
					signal: session.signal,
					authorization: "Bearer admin-secret",
				},
			],
		);
	});

	test("retries only Worker-limited imports in ordered 40-account chunks", async () => {
		const requestSizes = [];
		await withAdminFetch(
			async (_path, init) => {
				const payload = JSON.parse(String(init?.body || "{}"));
				requestSizes.push(payload.accounts.length);
				if (requestSizes.length === 1)
					return Response.json(
						{
							error: {
								message: "Worker import limit exceeded",
								code: "gemini_import_account_limit_exceeded",
							},
						},
						{ status: 413 },
					);
				return Response.json(
					uiMutation({
						processed: payload.accounts.length,
						changed: payload.accounts.length,
					}),
				);
			},
			async () => {
				const result = await createAccountsWithLimitFallback(
					uiAdminApiSession(),
					{ accounts: uiImportBatch(81) },
				);
				assert.deepEqual(result, {
					processed: 81,
					changed: 81,
					unchanged: 0,
					failed: 0,
				});
			},
		);

		assert.deepEqual(requestSizes, [81, 40, 40, 1]);
	});

	test("does not retry non-JSON 413 import failures", async () => {
		let requests = 0;
		await withAdminFetch(
			async () => {
				requests++;
				return new Response("upstream failure", { status: 413 });
			},
			async () => {
				await assert.rejects(
					() =>
						createAccountsWithLimitFallback(uiAdminApiSession(), {
							accounts: uiImportBatch(81),
						}),
					/Request failed with status 413/,
				);
			},
		);
		assert.equal(requests, 1);
	});

	test("does not retry unrelated JSON 413 import failures", async () => {
		let requests = 0;
		await withAdminFetch(
			async () => {
				requests++;
				return Response.json(
					{
						error: {
							message: "A different payload limit was exceeded",
							code: "request_body_too_large",
						},
					},
					{ status: 413 },
				);
			},
			async () => {
				await assert.rejects(
					() =>
						createAccountsWithLimitFallback(uiAdminApiSession(), {
							accounts: uiImportBatch(81),
						}),
					/A different payload limit was exceeded/,
				);
			},
		);
		assert.equal(requests, 1);
	});

	test("does not retry Worker-limit failures at or below the chunk size", async () => {
		let requests = 0;
		await withAdminFetch(
			async () => {
				requests++;
				return Response.json(
					{
						error: {
							message: "Worker import limit exceeded",
							code: "gemini_import_account_limit_exceeded",
						},
					},
					{ status: 413 },
				);
			},
			async () => {
				await assert.rejects(
					() =>
						createAccountsWithLimitFallback(uiAdminApiSession(), {
							accounts: uiImportBatch(40),
						}),
					/Worker import limit exceeded/,
				);
			},
		);
		assert.equal(requests, 1);
	});
});
