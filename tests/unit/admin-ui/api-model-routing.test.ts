import { describe, test } from "vitest";
import {
	getModelRoutingOverview,
	replaceModelRoutePriority,
	resetModelRoutePriority,
} from "../../../src/admin-ui/api";
import { assert } from "../assertions.js";
import { withAdminFetch } from "./_support/environment.js";
import {
	type RecordedRequest,
	recordedRequest,
	requestBody,
	requestHeaders,
	requiredValue,
	uiAdminApiSession,
	uiModelRouting,
} from "./_support/fixtures.js";

describe("admin UI model-routing API", () => {
	test("sends exact methods, bodies, authorization, and abort signals", async () => {
		const overview = uiModelRouting();
		const requests: RecordedRequest[] = [];
		const session = uiAdminApiSession();
		await withAdminFetch(
			async (path: RequestInfo | URL, init: RequestInit = {}) => {
				requests.push(recordedRequest(path, init));
				return Response.json(overview);
			},
			async () => {
				await getModelRoutingOverview(session);
				await replaceModelRoutePriority(session, "pro", [
					{
						providerModelId: "9d8ca3786ebdfbea",
						capacity: 3,
						capacityField: 13,
						modelNumber: 3,
					},
				]);
				await resetModelRoutePriority(session, "pro");
			},
		);

		assert.deepEqual(
			requests.map((item) => [item.path, item.init.method || "GET"]),
			[
				["/admin/model-routing", "GET"],
				["/admin/model-routing/pro", "PUT"],
				["/admin/model-routing/pro", "DELETE"],
			],
		);
		assert.deepEqual(JSON.parse(requestBody(requiredValue(requests[1]).init)), {
			routes: [
				{
					providerModelId: "9d8ca3786ebdfbea",
					capacity: 3,
					capacityField: 13,
					modelNumber: 3,
				},
			],
		});
		assert.equal(
			requests.every(
				(item) =>
					item.init.signal === session.signal &&
					requestHeaders(item.init).get("Authorization") ===
						"Bearer admin-secret",
			),
			true,
		);
	});
});
