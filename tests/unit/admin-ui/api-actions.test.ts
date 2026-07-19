// @ts-nocheck
import { describe, test } from "vitest";
import { runAccountAction } from "../../../src/admin-ui/api";
import { assert } from "../assertions.js";
import { withAdminFetch } from "./_support/environment.js";
import { uiAdminApiSession, uiMutation } from "./_support/fixtures.js";

const BULK_ACTION_LIMIT_CODE = "admin_bulk_action_limit_exceeded";

function accountIdentifiers(count) {
	return Array.from({ length: count }, (_value, index) => ({
		id: `account-${index}`,
	}));
}

function bulkLimitResponse(status = 413, code = BULK_ACTION_LIMIT_CODE) {
	return Response.json(
		{
			error: {
				message: "Worker bulk action limit exceeded",
				code,
			},
		},
		{ status },
	);
}

describe("admin UI bulk account action API", () => {
	test("sends the full action first and returns without chunking when accepted", async () => {
		const identifiers = accountIdentifiers(205);
		const requests = [];
		const session = uiAdminApiSession();
		let result;

		await withAdminFetch(
			async (path, init = {}) => {
				requests.push({ path, init });
				return Response.json(
					uiMutation({ processed: 205, changed: 204, unchanged: 1 }),
				);
			},
			async () => {
				result = await runAccountAction(session, "refresh", identifiers);
			},
		);

		assert.deepEqual(result, {
			processed: 205,
			changed: 204,
			unchanged: 1,
			failed: 0,
		});
		assert.equal(requests.length, 1);
		assert.deepEqual(
			{
				path: requests[0].path,
				method: requests[0].init.method,
				body: JSON.parse(requests[0].init.body),
				signal: requests[0].init.signal,
				authorization: requests[0].init.headers.Authorization,
			},
			{
				path: "/admin/accounts/actions",
				method: "POST",
				body: {
					action: "refresh",
					ids: identifiers.map(({ id }) => id),
				},
				signal: session.signal,
				authorization: "Bearer admin-secret",
			},
		);
	});

	test("retries the exact Worker limit in ordered 100-account chunks and merges results", async () => {
		const identifiers = accountIdentifiers(205);
		const requestIds = [];
		let result;

		await withAdminFetch(
			async (_path, init = {}) => {
				const ids = JSON.parse(init.body).ids;
				requestIds.push(ids);
				if (requestIds.length === 1) return bulkLimitResponse();
				if (requestIds.length === 2)
					return Response.json(
						uiMutation({
							processed: 100,
							changed: 97,
							unchanged: 1,
							failed: 2,
							errors: [
								{
									id: "account-20",
									code: "refresh_failed",
									message: "first chunk failure",
								},
							],
						}),
					);
				if (requestIds.length === 3)
					return Response.json(
						uiMutation({ processed: 100, changed: 99, unchanged: 1 }),
					);
				return Response.json(
					uiMutation({
						processed: 5,
						changed: 4,
						failed: 1,
						errors: [
							{
								id: "account-204",
								code: "refresh_failed",
								message: "last chunk failure",
							},
						],
					}),
				);
			},
			async () => {
				result = await runAccountAction(
					uiAdminApiSession(),
					"refresh",
					identifiers,
				);
			},
		);

		assert.deepEqual(
			requestIds,
			[
				identifiers,
				identifiers.slice(0, 100),
				identifiers.slice(100, 200),
				identifiers.slice(200),
			].map((batch) => batch.map(({ id }) => id)),
		);
		assert.deepEqual(result, {
			processed: 205,
			changed: 200,
			unchanged: 2,
			failed: 3,
			errors: [
				{
					id: "account-20",
					code: "refresh_failed",
					message: "first chunk failure",
				},
				{
					id: "account-204",
					code: "refresh_failed",
					message: "last chunk failure",
				},
			],
		});
	});

	test("does not retry the bulk limit code with a non-413 status", async () => {
		let requests = 0;
		await withAdminFetch(
			async () => {
				requests++;
				return bulkLimitResponse(429);
			},
			async () => {
				await assert.rejects(
					() =>
						runAccountAction(
							uiAdminApiSession(),
							"disable",
							accountIdentifiers(101),
						),
					/Worker bulk action limit exceeded/,
				);
			},
		);
		assert.equal(requests, 1);
	});

	test("does not retry a 413 response with an unrelated error code", async () => {
		let requests = 0;
		await withAdminFetch(
			async () => {
				requests++;
				return bulkLimitResponse(413, "request_body_too_large");
			},
			async () => {
				await assert.rejects(
					() =>
						runAccountAction(
							uiAdminApiSession(),
							"enable",
							accountIdentifiers(101),
						),
					/Worker bulk action limit exceeded/,
				);
			},
		);
		assert.equal(requests, 1);
	});

	test("stops before the next chunk when the admin session is aborted", async () => {
		const controller = new AbortController();
		const session = { adminKey: "admin-secret", signal: controller.signal };
		const identifiers = accountIdentifiers(201);
		const requestIds = [];
		let thrown;

		await withAdminFetch(
			async (_path, init = {}) => {
				const ids = JSON.parse(init.body).ids;
				requestIds.push(ids);
				if (requestIds.length === 1) return bulkLimitResponse();
				controller.abort();
				return Response.json(
					uiMutation({ processed: ids.length, changed: ids.length }),
				);
			},
			async () => {
				try {
					await runAccountAction(session, "delete", identifiers);
				} catch (error) {
					thrown = error;
				}
			},
		);

		assert.equal(thrown?.name, "AbortError");
		assert.match(thrown?.message || "", /Admin session is no longer active/);
		assert.deepEqual(
			requestIds,
			[identifiers, identifiers.slice(0, 100)].map((batch) =>
				batch.map(({ id }) => id),
			),
		);
	});
});
