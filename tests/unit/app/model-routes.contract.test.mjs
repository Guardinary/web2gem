import { describe, test } from "vitest";
import worker from "../../../src/index";
import { assert } from "../assertions.js";

function modelCatalogD1(includeModels = true) {
	const nowMs = Date.now();
	const account = {
		id: "catalog-account",
		enabled: 1,
		cookie_header: "__Secure-1PSID=catalog; __Secure-1PSIDTS=ts",
		cookie_hash: "catalog-hash",
		issue: null,
		cooldown_until_ms: null,
		last_used_at_ms: null,
		status_checked_at_ms: nowMs,
		last_refresh_success_at_ms: nowMs,
	};
	const capabilities = includeModels
		? [
				{
					account_id: account.id,
					model_id: "9d8ca3786ebdfbea",
					display_name: "Gemini Pro",
					description: "Pro model",
					available: 1,
					capacity: 1,
					capacity_field: 12,
					model_number: 3,
					discovery_order: 0,
					checked_at_ms: nowMs,
				},
				{
					account_id: account.id,
					model_id: "future-model",
					display_name: "Future Model",
					description: "Future model description",
					available: 1,
					capacity: 3,
					capacity_field: 13,
					model_number: 7,
					discovery_order: 1,
					checked_at_ms: nowMs,
				},
			]
		: [];
	return {
		prepare(sql) {
			return {
				bind() {
					return this;
				},
				async first(column) {
					if (sql.includes("FROM gemini_pool_meta") && column === "value")
						return "1";
					return null;
				},
				async all() {
					if (sql.includes("FROM gemini_accounts"))
						return { results: includeModels ? [account] : [] };
					if (sql.includes("FROM gemini_account_models"))
						return { results: capabilities };
					if (sql.includes("FROM gemini_model_route_priority"))
						return { results: [] };
					throw new Error(`unexpected catalog D1 query: ${sql}`);
				},
			};
		},
	};
}

describe("application model route contract", () => {
	test("serves OpenAI model list route", async () => {
		const resp = await worker.fetch(
			new Request("https://worker.example/v1/models"),
			{},
			{},
		);
		assert.equal(resp.status, 200);
		assert.deepEqual(
			(await resp.json()).data.map((model) => model.id),
			["gemini-3.5-flash", "gemini-3.5-flash-extended"],
		);
		const emptyD1 = await worker.fetch(
			new Request("https://worker.example/v1/models"),
			{ GEMINI_DB: modelCatalogD1(false) },
			{},
		);
		assert.deepEqual(
			(await emptyD1.json()).data.map((model) => model.id),
			["gemini-3.5-flash", "gemini-3.5-flash-extended"],
		);
	});
	test("serves health and OpenAI model detail routes", async () => {
		const health = await worker.fetch(
			new Request("https://worker.example/"),
			{
				API_KEYS: "sk-test",
			},
			{},
		);
		assert.equal(health.status, 200);
		const healthBody = await health.json();
		assert.equal(healthBody.status, "ok");
		assert.equal(Array.isArray(healthBody.models), true);

		const model = await worker.fetch(
			new Request("https://worker.example/v1/models/gemini-3.5-flash"),
			{},
			{},
		);
		assert.equal(model.status, 200);
		const modelBody = await model.json();
		assert.equal(modelBody.id, "gemini-3.5-flash");
		assert.equal(modelBody.object, "model");
	});
	test("keeps health D1-free and degrades model catalogs on D1 failure", async () => {
		let prepareCalls = 0;
		const env = {
			API_KEYS: "sk-test",
			GEMINI_DB: {
				prepare() {
					prepareCalls++;
					throw new Error("model and health routes must not touch D1");
				},
			},
		};
		const health = await worker.fetch(
			new Request("https://worker.example/"),
			env,
			{},
		);
		assert.equal(health.status, 200);
		assert.equal(prepareCalls, 0);
		const unauthorized = await worker.fetch(
			new Request("https://worker.example/v1/models"),
			env,
			{},
		);
		assert.equal(unauthorized.status, 401);
		assert.equal(prepareCalls, 0);
		const openaiModels = await worker.fetch(
			new Request("https://worker.example/v1/models", {
				headers: { Authorization: "Bearer sk-test" },
			}),
			env,
			{},
		);
		assert.equal(openaiModels.status, 200);
		assert.deepEqual(
			(await openaiModels.json()).data.map((model) => model.id),
			["gemini-3.5-flash", "gemini-3.5-flash-extended"],
		);
		const googleModels = await worker.fetch(
			new Request("https://worker.example/v1beta/models", {
				headers: { Authorization: "Bearer sk-test" },
			}),
			env,
			{},
		);
		assert.equal(googleModels.status, 200);
		assert.deepEqual(
			(await googleModels.json()).models.map((model) =>
				model.name.slice("models/".length),
			),
			["gemini-3.5-flash", "gemini-3.5-flash-extended"],
		);
		assert.equal(prepareCalls, 2);
	});
	test("serves one ordered dynamic catalog through OpenAI and Google routes", async () => {
		const env = { GEMINI_DB: modelCatalogD1() };
		const openai = await worker.fetch(
			new Request("https://worker.example/v1/models"),
			env,
			{},
		);
		const openaiBody = await openai.json();
		const openaiIds = openaiBody.data.map((model) => model.id);
		assert.deepEqual(openaiIds, [
			"gemini-3.5-flash",
			"gemini-3.5-flash-extended",
			"gemini-3.1-pro",
			"gemini-3.1-pro-extended",
			"future-model",
			"future-model-extended",
		]);
		assert.deepEqual(Object.keys(openaiBody.data[0]), [
			"id",
			"object",
			"created",
			"owned_by",
		]);

		const google = await worker.fetch(
			new Request("https://worker.example/v1beta/models"),
			env,
			{},
		);
		const googleIds = (await google.json()).models.map((model) =>
			model.name.slice("models/".length),
		);
		assert.deepEqual(googleIds, openaiIds);

		for (const path of [
			"/v1/models/future-model-extended",
			"/v1beta/models/future-model-extended",
		]) {
			const detail = await worker.fetch(
				new Request(`https://worker.example${path}`),
				env,
				{},
			);
			assert.equal(detail.status, 200);
		}
		const health = await worker.fetch(
			new Request("https://worker.example/"),
			env,
			{},
		);
		assert.deepEqual((await health.json()).models, [
			"gemini-3.1-pro",
			"gemini-3.1-pro-extended",
			"gemini-3.5-flash",
			"gemini-3.5-flash-extended",
			"gemini-3.1-flash-lite",
			"gemini-3.1-flash-lite-extended",
		]);
	});
	test("serves Google model routes and rejects prefix lookalikes", async () => {
		const listResp = await worker.fetch(
			new Request("https://worker.example/v1beta/models"),
			{},
			{},
		);
		assert.equal(listResp.status, 200);
		const listBody = await listResp.json();
		assert.equal(Array.isArray(listBody.models), true);
		const modelPathResp = await worker.fetch(
			new Request("https://worker.example/v1beta/models/gemini-3.5-flash"),
			{},
			{},
		);
		assert.equal(modelPathResp.status, 200);
		const modelPathBody = await modelPathResp.json();
		assert.equal(modelPathBody.name, "models/gemini-3.5-flash");
		assert.equal(modelPathBody.displayName, "Gemini 3.5 Flash");
		assert.deepEqual(modelPathBody.supportedGenerationMethods, [
			"generateContent",
			"streamGenerateContent",
		]);
		assert.equal(modelPathBody.models, undefined);
		const missingModelResp = await worker.fetch(
			new Request("https://worker.example/v1beta/models/not-a-model"),
			{},
			{},
		);
		assert.equal(missingModelResp.status, 404);
		const missingModelBody = await missingModelResp.json();
		assert.equal(missingModelBody.error.code, "model_not_found");
		const invalidPrefixResp = await worker.fetch(
			new Request("https://worker.example/v1beta/modelsXYZ"),
			{},
			{},
		);
		assert.equal(invalidPrefixResp.status, 404);
	});
});
