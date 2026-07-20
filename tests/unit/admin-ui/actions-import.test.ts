import { afterEach, describe, test } from "vitest";
import { resetImport, submitImport } from "../../../src/admin-ui/actions";
import { language } from "../../../src/admin-ui/i18n";
import { updateAdminKey } from "../../../src/admin-ui/session";
import {
	connectionVerified,
	importBatch,
	importBusy,
	importLabel,
	importPsid,
	importPsidts,
	toastItems,
} from "../../../src/admin-ui/state";
import { isRecord } from "../../../src/shared/types";
import { deferred } from "../_support/deferred.js";
import { assert } from "../assertions.js";
import { withAdminEnvironment } from "./_support/environment.js";
import {
	type RecordedRequest,
	recordedRequest,
	requestBody,
	requiredValue,
	uiAccountOverview,
	uiImportBatchText,
	uiMutation,
} from "./_support/fixtures.js";
import { resetAdminSessionState, resetImportState } from "./_support/state.js";

describe("admin UI import actions", () => {
	afterEach(() => {
		language.value = "en";
		resetImportState();
		resetAdminSessionState();
	});

	test("blocks account import until the admin session is verified", async () => {
		let requests = 0;
		await withAdminEnvironment(
			async () => {
				requests++;
				return Response.json(uiMutation());
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = false;
				importPsid.value = "psid-value";
				importPsidts.value = "psidts-value";

				await submitImport(new Event("submit"));
			},
		);

		assert.equal(requests, 0);
	});

	test("submits a single import, clears its draft, and reloads accounts", async () => {
		const requests: RecordedRequest[] = [];
		await withAdminEnvironment(
			async (path: RequestInfo | URL, init: RequestInit = {}) => {
				requests.push(recordedRequest(path, init));
				return init.method === "POST"
					? Response.json(uiMutation())
					: Response.json(uiAccountOverview());
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				importLabel.value = "  Primary  ";
				importPsid.value = " psid-value ";
				importPsidts.value = " psidts-value ";

				await submitImport(new Event("submit"));

				assert.equal(importBusy.value, false);
				assert.deepEqual(
					[
						importLabel.value,
						importPsid.value,
						importPsidts.value,
						importBatch.value,
					],
					["", "", "", ""],
				);
			},
		);

		assert.deepEqual(
			requests.map(({ path, init }) => [path, init.method || "GET"]),
			[
				["/admin/accounts", "POST"],
				["/admin/accounts?limit=200", "GET"],
			],
		);
		assert.deepEqual(JSON.parse(requestBody(requiredValue(requests[0]).init)), {
			provider: "gemini",
			label: "Primary",
			"__Secure-1PSID": "psid-value",
			"__Secure-1PSIDTS": "psidts-value",
		});
	});

	test("localizes malformed batch rows without issuing a request or clearing the draft", async () => {
		let requests = 0;
		await withAdminEnvironment(
			async () => {
				requests++;
				return Response.json(uiMutation());
			},
			async () => {
				language.value = "zh-CN";
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				importBatch.value = "psid-only";

				await submitImport(new Event("submit"));

				assert.equal(importBusy.value, false);
				assert.equal(importBatch.value, "psid-only");
			},
		);

		assert.equal(requests, 0);
		assert.equal(toastItems.value[0]?.message, "每行必须包含 PSID 和 PSIDTS");
	});

	test("localizes missing single-account credentials without issuing a request or clearing the draft", async () => {
		let requests = 0;
		await withAdminEnvironment(
			async () => {
				requests++;
				return Response.json(uiMutation());
			},
			async () => {
				language.value = "zh-CN";
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				importLabel.value = "Primary";
				importPsidts.value = "psidts-value";

				await submitImport(new Event("submit"));

				assert.equal(importBusy.value, false);
				assert.deepEqual(
					[importLabel.value, importPsid.value, importPsidts.value],
					["Primary", "", "psidts-value"],
				);
			},
		);

		assert.equal(requests, 0);
		assert.equal(toastItems.value[0]?.message, "需要填写 __Secure-1PSID");
	});

	test("resets single and batch import drafts together", () => {
		importLabel.value = "Label";
		importPsid.value = "psid";
		importPsidts.value = "psidts";
		importBatch.value = "batch";

		resetImport();

		assert.deepEqual(
			[
				importLabel.value,
				importPsid.value,
				importPsidts.value,
				importBatch.value,
			],
			["", "", "", ""],
		);
	});

	test("aborts the full import request tree when the admin session changes", async () => {
		const requestSizes: number[] = [];
		const chunkStarted = deferred();
		const chunkResponse = deferred();
		let activeChunkSignal: AbortSignal | undefined;
		try {
			await withAdminEnvironment(
				async (_path: RequestInfo | URL, init: RequestInit = {}) => {
					const payload: unknown = JSON.parse(requestBody(init));
					if (!isRecord(payload) || !Array.isArray(payload.accounts))
						throw new TypeError("expected an accounts payload");
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
					activeChunkSignal = requiredValue(init.signal);
					activeChunkSignal.addEventListener(
						"abort",
						() => chunkResponse.resolve(Response.json(uiMutation())),
						{ once: true },
					);
					chunkStarted.resolve();
					return chunkResponse.promise;
				},
				async () => {
					updateAdminKey("old-admin-key");
					connectionVerified.value = true;
					importBatch.value = uiImportBatchText(81);

					const importing = submitImport(new Event("submit"));
					await chunkStarted.promise;
					updateAdminKey("new-admin-key");
					await importing;

					assert.deepEqual(requestSizes, [81, 40]);
					assert.equal(requiredValue(activeChunkSignal).aborted, true);
					assert.equal(connectionVerified.value, false);
				},
			);
		} finally {
			chunkStarted.resolve();
			chunkResponse.resolve(Response.json(uiMutation()));
		}
	});
});
