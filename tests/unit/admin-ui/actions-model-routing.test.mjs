import { afterEach, describe, test } from "vitest";
import {
	moveModelRoute,
	resetModelRoutePriorityAction,
	saveModelRoutePriority,
} from "../../../src/admin-ui/actions";
import { updateAdminKey } from "../../../src/admin-ui/session";
import {
	connectionVerified,
	modelRouting,
	modelRoutingDrafts,
} from "../../../src/admin-ui/state";
import { assert } from "../assertions.js";
import { deferred } from "../_support/deferred.js";
import { withAdminEnvironment } from "./_support/environment.js";
import { uiModelRouting } from "./_support/fixtures.js";
import {
	resetAdminSessionState,
	resetModelRoutingState,
} from "./_support/state.js";

function route(providerModelId, overrides = {}) {
	return {
		...uiModelRouting().families[0].routes[0],
		providerModelId,
		...overrides,
	};
}

function routingOverview(version, proRoutes, flashRoutes = []) {
	const base = uiModelRouting();
	return {
		...base,
		version,
		families: base.families.map((family) => {
			if (family.family === "pro")
				return { ...family, configured: true, routes: proRoutes };
			if (family.family === "flash")
				return { ...family, configured: true, routes: flashRoutes };
			return family;
		}),
	};
}

describe("admin UI model-routing actions", () => {
	afterEach(() => {
		resetModelRoutingState();
		resetAdminSessionState();
	});

	test("moves one family draft without mutating the saved overview or siblings", () => {
		const saved = uiModelRouting();
		const first = saved.families[0].routes[0];
		const second = route("pro-second", { capacity: 4, capacityField: 12 });
		const flash = route("flash-draft", {
			capacity: 4,
			capacityField: 12,
			modelNumber: 1,
		});
		modelRouting.value = saved;
		modelRoutingDrafts.value = {
			pro: {
				routes: [first, second],
				busy: false,
				error: "old error",
				dirty: false,
			},
			flash: { routes: [flash], busy: false, error: null, dirty: true },
			flash_lite: { routes: [], busy: false, error: null, dirty: false },
		};

		moveModelRoute("pro", 1, -1);

		assert.deepEqual(
			modelRoutingDrafts.value.pro.routes.map((item) => item.providerModelId),
			["pro-second", "9d8ca3786ebdfbea"],
		);
		assert.equal(modelRoutingDrafts.value.pro.dirty, true);
		assert.equal(modelRoutingDrafts.value.pro.error, null);
		assert.equal(
			modelRouting.value.families[0].routes[0].providerModelId,
			"9d8ca3786ebdfbea",
		);
		assert.deepEqual(modelRoutingDrafts.value.flash.routes, [flash]);
		assert.equal(modelRoutingDrafts.value.flash.dirty, true);
	});

	test("saves one family while preserving another family's dirty draft", async () => {
		const pro = route("pro-saved");
		const flashDraft = route("flash-draft", { modelNumber: 1 });
		const returned = routingOverview("2", [pro]);
		let request;
		await withAdminEnvironment(
			async (path, init = {}) => {
				request = { path: String(path), init };
				return Response.json(returned);
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				modelRouting.value = routingOverview("1", [route("pro-old")]);
				modelRoutingDrafts.value = {
					pro: { routes: [pro], busy: false, error: null, dirty: true },
					flash: {
						routes: [flashDraft],
						busy: false,
						error: null,
						dirty: true,
					},
					flash_lite: {
						routes: [],
						busy: false,
						error: null,
						dirty: false,
					},
				};

				await saveModelRoutePriority("pro");
			},
		);

		assert.deepEqual(
			[request.path, request.init.method],
			["/admin/model-routing/pro", "PUT"],
		);
		assert.deepEqual(JSON.parse(request.init.body), {
			routes: [
				{
					providerModelId: "pro-saved",
					capacity: 3,
					capacityField: 13,
					modelNumber: 3,
				},
			],
		});
		assert.equal(modelRouting.value.version, "2");
		assert.equal(modelRoutingDrafts.value.pro.dirty, false);
		assert.deepEqual(modelRoutingDrafts.value.flash.routes, [flashDraft]);
		assert.equal(modelRoutingDrafts.value.flash.dirty, true);
	});

	test("keeps the newest routing snapshot across out-of-order family saves", async () => {
		const proOld = route("pro-old");
		const proNew = route("pro-new");
		const flashOld = route("flash-old", { modelNumber: 1 });
		const flashNew = route("flash-new", { modelNumber: 1 });
		const proStarted = deferred();
		const flashStarted = deferred();
		const proResponse = deferred();
		const flashResponse = deferred();
		try {
			await withAdminEnvironment(
				async (path) => {
					if (String(path).endsWith("/pro")) {
						proStarted.resolve();
						return proResponse.promise;
					}
					flashStarted.resolve();
					return flashResponse.promise;
				},
				async () => {
					updateAdminKey("admin-secret");
					connectionVerified.value = true;
					modelRouting.value = routingOverview("8", [proOld], [flashOld]);
					modelRoutingDrafts.value = {
						pro: {
							routes: [proNew],
							busy: false,
							error: null,
							dirty: true,
						},
						flash: {
							routes: [flashNew],
							busy: false,
							error: null,
							dirty: true,
						},
						flash_lite: {
							routes: [],
							busy: false,
							error: null,
							dirty: false,
						},
					};

					const proSave = saveModelRoutePriority("pro");
					await proStarted.promise;
					const flashSave = saveModelRoutePriority("flash");
					await flashStarted.promise;
					flashResponse.resolve(
						Response.json(routingOverview("10", [proNew], [flashNew])),
					);
					await flashSave;
					proResponse.resolve(
						Response.json(routingOverview("9", [proNew], [flashOld])),
					);
					await proSave;
				},
			);

			assert.equal(modelRouting.value.version, "10");
			assert.equal(
				modelRouting.value.families.find((family) => family.family === "flash")
					.routes[0].providerModelId,
				"flash-new",
			);
			assert.equal(
				modelRoutingDrafts.value.pro.routes[0].providerModelId,
				"pro-new",
			);
			assert.equal(
				modelRoutingDrafts.value.flash.routes[0].providerModelId,
				"flash-new",
			);
			assert.deepEqual(
				[
					modelRoutingDrafts.value.pro.busy,
					modelRoutingDrafts.value.pro.dirty,
					modelRoutingDrafts.value.flash.busy,
					modelRoutingDrafts.value.flash.dirty,
				],
				[false, false, false, false],
			);
		} finally {
			proStarted.resolve();
			flashStarted.resolve();
			proResponse.resolve(Response.json(routingOverview("11", [proNew])));
			flashResponse.resolve(
				Response.json(routingOverview("11", [proNew], [flashNew])),
			);
		}
	});

	test("invalidates the verified session when a routing mutation is rejected", async () => {
		await withAdminEnvironment(
			async () =>
				Response.json(
					{
						error: {
							code: "invalid_admin_key",
							message: "invalid admin key",
						},
					},
					{ status: 401 },
				),
			async () => {
				const overview = uiModelRouting();
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				modelRouting.value = overview;
				modelRoutingDrafts.value = {
					pro: {
						routes: overview.families[0].routes,
						busy: false,
						error: null,
						dirty: true,
					},
					flash: { routes: [], busy: false, error: null, dirty: false },
					flash_lite: { routes: [], busy: false, error: null, dirty: false },
				};

				await saveModelRoutePriority("pro");
			},
		);

		assert.equal(connectionVerified.value, false);
		assert.equal(modelRouting.value, null);
		assert.deepEqual(modelRoutingDrafts.value.pro, {
			routes: [],
			busy: false,
			error: null,
			dirty: false,
		});
	});

	test("resets one family from the server overview", async () => {
		const discovered = route("pro-discovered");
		const returned = routingOverview("3", [discovered]);
		let request;
		await withAdminEnvironment(
			async (path, init = {}) => {
				request = { path: String(path), init };
				return Response.json(returned);
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				modelRouting.value = routingOverview("2", [route("pro-custom")]);
				modelRoutingDrafts.value = {
					pro: {
						routes: [route("pro-custom")],
						busy: false,
						error: null,
						dirty: true,
					},
					flash: { routes: [], busy: false, error: null, dirty: false },
					flash_lite: { routes: [], busy: false, error: null, dirty: false },
				};

				await resetModelRoutePriorityAction("pro");
			},
		);

		assert.deepEqual(
			[request.path, request.init.method, request.init.body],
			["/admin/model-routing/pro", "DELETE", undefined],
		);
		assert.equal(modelRouting.value.version, "3");
		assert.deepEqual(modelRoutingDrafts.value.pro, {
			routes: [discovered],
			busy: false,
			error: null,
			dirty: false,
		});
	});
});
