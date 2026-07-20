import { describe, test } from "vitest";
import type { ApplicationExecutionContext } from "../../../src/app";
import type { WorkerEnv } from "../../../src/config";
import workerHandler from "../../../src/index";
import { isRecord, type UnknownRecord } from "../../../src/shared/types";
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
		prepare(sql: string) {
			return {
				bind() {
					return this;
				},
				async first(column?: string) {
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

const executionContext: ApplicationExecutionContext = { waitUntil() {} };
const worker = {
	fetch(
		request: Request,
		env: WorkerEnv = {},
		_execution?: unknown,
	): Promise<Response> {
		return workerHandler.fetch(request, env, executionContext);
	},
};

function record(value: unknown, label: string): UnknownRecord {
	if (!isRecord(value)) throw new Error(`expected ${label}`);
	return value;
}

function recordsAt(value: unknown, key: string): UnknownRecord[] {
	const entries = record(value, "response")[key];
	if (!Array.isArray(entries)) throw new Error(`expected ${key}`);
	return entries.map((entry) => record(entry, key));
}

function stringField(value: UnknownRecord, key: string): string {
	const field = value[key];
	if (typeof field !== "string") throw new Error(`expected string ${key}`);
	return field;
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
			recordsAt(await resp.json(), "data").map((model) =>
				stringField(model, "id"),
			),
			["gemini-3.5-flash", "gemini-3.5-flash-extended"],
		);
		const emptyD1 = await worker.fetch(
			new Request("https://worker.example/v1/models"),
			{ GEMINI_DB: modelCatalogD1(false) },
			{},
		);
		assert.deepEqual(
			recordsAt(await emptyD1.json(), "data").map((model) =>
				stringField(model, "id"),
			),
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
		const healthBody = record(await health.json(), "health body");
		assert.equal(healthBody.status, "ok");
		assert.equal(Array.isArray(healthBody.models), true);

		const model = await worker.fetch(
			new Request("https://worker.example/v1/models/gemini-3.5-flash"),
			{},
			{},
		);
		assert.equal(model.status, 200);
		const modelBody = record(await model.json(), "model body");
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
			recordsAt(await openaiModels.json(), "data").map((model) =>
				stringField(model, "id"),
			),
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
			recordsAt(await googleModels.json(), "models").map((model) =>
				stringField(model, "name").slice("models/".length),
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
		const openaiBody = record(await openai.json(), "OpenAI body");
		const openaiData = recordsAt(openaiBody, "data");
		const openaiIds = openaiData.map((model) => stringField(model, "id"));
		assert.deepEqual(openaiIds, [
			"gemini-3.5-flash",
			"gemini-3.5-flash-extended",
			"gemini-3.1-pro",
			"gemini-3.1-pro-extended",
			"future-model",
			"future-model-extended",
		]);
		const firstOpenAIModel = openaiData[0];
		if (!firstOpenAIModel) throw new Error("expected OpenAI model");
		assert.deepEqual(Object.keys(firstOpenAIModel), [
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
		const googleIds = recordsAt(await google.json(), "models").map((model) =>
			stringField(model, "name").slice("models/".length),
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
		assert.deepEqual(record(await health.json(), "health body").models, [
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
		const listBody = record(await listResp.json(), "model list body");
		assert.equal(Array.isArray(listBody.models), true);
		const modelPathResp = await worker.fetch(
			new Request("https://worker.example/v1beta/models/gemini-3.5-flash"),
			{},
			{},
		);
		assert.equal(modelPathResp.status, 200);
		const modelPathBody = record(
			await modelPathResp.json(),
			"model detail body",
		);
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
		const missingModelBody = record(
			await missingModelResp.json(),
			"missing model body",
		);
		assert.equal(
			record(missingModelBody.error, "error body").code,
			"model_not_found",
		);
		const invalidPrefixResp = await worker.fetch(
			new Request("https://worker.example/v1beta/modelsXYZ"),
			{},
			{},
		);
		assert.equal(invalidPrefixResp.status, 404);
	});
});
