import { describe, test } from "vitest";
import { verifyGeminiAccount } from "../../../../src/gemini/accounts/probe";
import type { GeminiAccountProbe } from "../../../../src/gemini/accounts/probe-types";
import { withFetch } from "../../_support/globals.js";
import { assert } from "../../assertions.js";
import { baseGeminiClientConfig } from "../_support/client-fixtures.js";

function accountProbeWrb(
	statusCode: number,
	models: readonly unknown[] = [],
	tierFlags: readonly unknown[] = [],
	capabilityFlags: readonly unknown[] = [],
) {
	const payload: unknown[] = [];
	payload[14] = statusCode;
	payload[15] = models;
	payload[16] = tierFlags;
	payload[17] = capabilityFlags;
	return JSON.stringify([["wrb.fr", "otAQ7b", JSON.stringify(payload)]]);
}

function requireProbe(result: {
	ok: true;
	probe?: GeminiAccountProbe;
}): GeminiAccountProbe {
	if (!result.probe) throw new Error("expected probe payload");
	return result.probe;
}

function probeModel(
	probe: GeminiAccountProbe,
	index: number,
): GeminiAccountProbe["models"][number] {
	const model = probe.models[index];
	if (!model) throw new Error(`missing probe model at index ${index}`);
	return model;
}

function appPageHtml(at = "probe-at-token"): string {
	return `<html><script>"SNlM0e":"${at}"</script></html>`;
}

async function verifyWithProbeResponse(
	probeBody: string,
	opts: {
		status?: number;
		bodyFactory?: () => BodyInit | null;
		appHtml?: string;
	} = {},
) {
	const cfg = baseGeminiClientConfig({
		cookie: "__Secure-1PSID=psid; SAPISID=sapi",
		gemini_origin: "https://gemini.example",
		upstream_socket: false,
	});
	return withFetch(
		async (url: RequestInfo | URL) => {
			const target = String(url);
			if (target.includes("/app") && !target.includes("batchexecute")) {
				return new Response(opts.appHtml ?? appPageHtml(), { status: 200 });
			}
			if (target.includes("batchexecute")) {
				const body =
					typeof opts.bodyFactory === "function"
						? opts.bodyFactory()
						: probeBody;
				return new Response(body, { status: opts.status ?? 200 });
			}
			throw new Error(`unexpected probe fetch ${target}`);
		},
		() => verifyGeminiAccount({ config: cfg, level: "status" }),
	);
}

describe("Gemini account probe decoding", () => {
	test("releases bounded probe readers without canceling normal EOF", async () => {
		let canceled = false;
		const result = await verifyWithProbeResponse(accountProbeWrb(1000), {
			bodyFactory() {
				return new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(accountProbeWrb(1000)));
						controller.close();
					},
					cancel() {
						canceled = true;
					},
				});
			},
		});
		assert.equal(result.ok, true);
		if (!result.ok) throw new Error("expected probe success");
		assert.equal(requireProbe(result).statusCode, 1000);
		assert.equal(canceled, false);
	});

	test("cancels and releases bounded probe readers on size errors", async () => {
		let canceled = false;
		const oversized = "x".repeat(512 * 1024 + 1);
		const result = await verifyWithProbeResponse(oversized, {
			bodyFactory() {
				return new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(oversized));
					},
					cancel() {
						canceled = true;
					},
				});
			},
		});
		assert.equal(result.ok, false);
		if (result.ok) throw new Error("expected probe failure");
		assert.equal(result.reason, "status_probe_failed");
		assert.equal(canceled, true);
	});

	test("preserves probe read errors while releasing the reader", async () => {
		const readError = new Error("probe read failed");
		const result = await verifyWithProbeResponse("", {
			bodyFactory() {
				return new ReadableStream({
					pull(controller) {
						controller.error(readError);
					},
				});
			},
		});
		assert.equal(result.ok, false);
		if (result.ok) throw new Error("expected probe failure");
		assert.equal(result.reason, "status_probe_failed");
	});

	test("decodes a selectable account and bounded model metadata", async () => {
		const result = await verifyWithProbeResponse(
			accountProbeWrb(1000, [["model-pro", "Pro", "description"]], [[21]]),
		);
		assert.equal(result.ok, true);
		if (!result.ok) throw new Error("expected probe success");
		assert.deepEqual(requireProbe(result), {
			statusCode: 1000,
			issue: null,
			models: [
				{
					modelId: "model-pro",
					displayName: "Pro",
					description: "description",
					available: true,
					capacity: 1,
					capacityField: 13,
					modelNumber: 1,
					discoveryOrder: 0,
				},
			],
		});
	});

	test("rejects unknown statuses and maps an authentication restriction", async () => {
		const unknown = await verifyWithProbeResponse(accountProbeWrb(9999));
		assert.equal(unknown.ok, false);
		if (unknown.ok) throw new Error("expected unknown status failure");
		assert.equal(unknown.reason, "status_probe_failed");

		const auth = await verifyWithProbeResponse(accountProbeWrb(1016));
		assert.equal(auth.ok, true);
		if (!auth.ok) throw new Error("expected auth probe success");
		assert.deepEqual(requireProbe(auth), {
			statusCode: 1016,
			issue: "auth",
			models: [],
		});
	});

	test("applies documented capacity and capacity-field precedence", async () => {
		for (const [tierFlags, capabilityFlags, expected] of [
			[[22], [], [2, 13]],
			[[], [115], [4, 12]],
			[[16], [], [3, 12]],
			[[], [106], [3, 12]],
			[[8], [], [2, 12]],
			[[], [19], [2, 12]],
			[[], [], [1, 12]],
		]) {
			const result = await verifyWithProbeResponse(
				accountProbeWrb(
					1000,
					[["model", "Model", ""]],
					tierFlags,
					capabilityFlags,
				),
			);
			assert.equal(result.ok, true);
			if (!result.ok) throw new Error("expected probe success");
			const model = probeModel(requireProbe(result), 0);
			assert.deepEqual([model.capacity, model.capacityField], expected);
		}
	});

	test("derives guest availability and provider model numbers", async () => {
		const result = await verifyWithProbeResponse(
			accountProbeWrb(1016, [
				["fbb127bbb056c959", "Flash", "Guest Flash"],
				["9d8ca3786ebdfbea", "Pro", "Authenticated Pro"],
			]),
		);
		assert.equal(result.ok, true);
		if (!result.ok) throw new Error("expected probe success");
		const probe = requireProbe(result);
		const flash = probeModel(probe, 0);
		const pro = probeModel(probe, 1);
		assert.equal(flash.available, true);
		assert.equal(flash.modelNumber, 1);
		assert.equal(pro.available, false);
		assert.equal(pro.modelNumber, 3);
	});

	test("drops model records with oversized or missing display metadata", async () => {
		const result = await verifyWithProbeResponse(
			accountProbeWrb(1000, [
				["valid-id", "x".repeat(257), "description"],
				["missing-display", "", "description"],
			]),
		);
		assert.equal(result.ok, true);
		if (!result.ok) throw new Error("expected probe success");
		assert.deepEqual(requireProbe(result).models, []);
	});

	test("fails when the app page lacks a usable at token", async () => {
		const result = await verifyWithProbeResponse(accountProbeWrb(1000), {
			appHtml: "<html>no token</html>",
		});
		assert.equal(result.ok, false);
		if (result.ok) throw new Error("expected missing token failure");
		assert.equal(result.reason, "missing_page_at_token");
	});
});
