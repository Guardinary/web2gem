import { describe, test } from "vitest";
import type { CompletionProvider } from "../../../src/completion/ports";
import type { RuntimeConfig } from "../../../src/config";
import type { GeminiAccountLease } from "../../../src/gemini/accounts/lease-types";
import { AccountPoolService } from "../../../src/gemini/accounts/pool";
import type { GeminiRouteTuple } from "../../../src/gemini/accounts/route-types";
import { basicRouteForFamily } from "../../../src/gemini/accounts/routes";
import type { GeminiAccountRuntime } from "../../../src/gemini/accounts/runtime";
import type { GeminiAccountAcquireOptions } from "../../../src/gemini/accounts/runtime-types";
import type { generateStream as geminiGenerateStream } from "../../../src/gemini/client";
import { createGeminiCompletionProvider } from "../../../src/gemini/completion-provider";
import type { ResolvedModelOk } from "../../../src/models";
import { assert } from "../assertions.js";
import { baseGeminiClientConfig } from "./_support/client-fixtures.js";
import { createRuntimeStore } from "./accounts/_support/runtime-fixtures.js";

type GenerateStream = typeof geminiGenerateStream;

function required<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined)
		throw new Error(`missing ${label}`);
	return value;
}

function proModel(): ResolvedModelOk {
	return {
		name: "gemini-3.1-pro",
		family: "pro",
		extended: false,
		dynamicProviderId: null,
	};
}

function routes(): GeminiRouteTuple[] {
	return [
		basicRouteForFamily("pro"),
		{
			providerModelId: "e6fa609c3fa255c0",
			capacity: 4,
			capacityField: 12,
			modelNumber: 3,
		},
	];
}

function streamLease(
	accountId: string,
	selectedRoute: GeminiRouteTuple,
	events: unknown[][],
): GeminiAccountLease {
	const config = baseGeminiClientConfig({
		cookie: `__Secure-1PSID=psid-${accountId}`,
		gemini_account: {
			accountId,
			cookieHash: `hash-${accountId}`,
		},
	});
	let released = false;
	return {
		accountId,
		selectedRoute,
		modelCapability: null,
		config,
		async refreshForRetry() {
			throw new Error("unexpected lease.refreshForRetry call");
		},
		async markSuccess() {
			events.push(["markSuccess", accountId]);
		},
		async markFailure(error: unknown) {
			events.push(["markFailure", accountId, error]);
		},
		async flushObservedCookies() {
			events.push(["flushObservedCookies", accountId]);
		},
		async maintainSessionIfStale() {
			throw new Error("unexpected lease.maintainSessionIfStale call");
		},
		release() {
			if (released) throw new Error(`lease ${accountId} released twice`);
			released = true;
			events.push(["release", accountId]);
		},
	};
}

function streamRuntime(
	leases: GeminiAccountLease[],
	routeCandidates: GeminiRouteTuple[],
): GeminiAccountRuntime & { acquire: string[][] } {
	const pending = [...leases];
	const acquire: string[][] = [];
	return {
		pool: new AccountPoolService(createRuntimeStore([]), {
			async rotateCookie() {
				throw new Error("unexpected cookie rotation");
			},
		}),
		acquire,
		async resolveModel(): Promise<never> {
			throw new Error("unexpected runtime.resolveModel call");
		},
		async modelCatalog(): Promise<never> {
			throw new Error("unexpected runtime.modelCatalog call");
		},
		async modelRoutingOverview(): Promise<never> {
			throw new Error("unexpected runtime.modelRoutingOverview call");
		},
		async routeCandidatesForModel() {
			return routeCandidates;
		},
		async acquireLease(
			_base: RuntimeConfig,
			options: GeminiAccountAcquireOptions = {},
		) {
			acquire.push([...(options.excludeAccountIds || [])]);
			if (!pending.length)
				throw new Error("unexpected extra account acquisition");
			return pending.shift() ?? null;
		},
	};
}

function createStreamProvider(
	runtime: GeminiAccountRuntime,
	generateStream: GenerateStream,
): CompletionProvider {
	return createGeminiCompletionProvider(baseGeminiClientConfig(), {
		accountRuntime: runtime,
		client: {
			async generate() {
				throw new Error("unexpected client.generate call");
			},
			async generateRich() {
				throw new Error("unexpected client.generateRich call");
			},
			generateStream,
		},
		uploads: {
			async resolveAttachments() {
				throw new Error("unexpected uploads.resolveAttachments call");
			},
			async uploadTextFile() {
				throw new Error("unexpected uploads.uploadTextFile call");
			},
		},
	});
}

async function captureStream(
	provider: CompletionProvider,
	output: string[],
): Promise<unknown> {
	try {
		for await (const delta of provider.streamText({
			prompt: "prompt",
			rm: proModel(),
			fileRefs: null,
		}))
			output.push(delta);
	} catch (error) {
		return error;
	}
	return null;
}

describe("Gemini account stream failover", () => {
	test("switches accounts only before the first visible delta", async () => {
		const routeCandidates = routes();
		const events: unknown[][] = [];
		const firstRoute = required(routeCandidates[0], "first route");
		const secondRoute = required(routeCandidates[1], "second route");
		const runtime = streamRuntime(
			[
				streamLease("a", firstRoute, events),
				streamLease("b", secondRoute, events),
			],
			routeCandidates,
		);
		const firstError = Object.assign(new Error("rate limited a"), {
			status: 429,
		});
		const calls: unknown[][] = [];
		const provider = createStreamProvider(
			runtime,
			async function* (
				activeCfg,
				_prompt,
				modelNumber,
				_extended,
				_refs,
				_options,
				headers,
			) {
				const account = activeCfg.gemini_account;
				if (!account || !headers) throw new Error("expected account headers");
				const header = headers["x-goog-ext-525001261-jspb"];
				if (!header) throw new Error("expected model header");
				const accountId = account.accountId;
				calls.push([accountId, modelNumber, JSON.parse(header)[4]]);
				if (accountId === "a") throw firstError;
				yield "account b";
			},
		);
		const output: string[] = [];
		assert.equal(await captureStream(provider, output), null);
		assert.deepEqual(output, ["account b"]);
		assert.deepEqual(calls, [
			["a", firstRoute.modelNumber, firstRoute.providerModelId],
			["b", secondRoute.modelNumber, secondRoute.providerModelId],
		]);
		assert.deepEqual(runtime.acquire, [[], ["a"]]);
		assert.equal(required(events[0], "first event")[2], firstError);
	});

	test("pins a stream to the selected account after visible output", async () => {
		const routeCandidates = routes();
		const events: unknown[][] = [];
		const firstRoute = required(routeCandidates[0], "first route");
		const secondRoute = required(routeCandidates[1], "second route");
		const runtime = streamRuntime(
			[
				streamLease("a", firstRoute, events),
				streamLease("b", secondRoute, events),
			],
			routeCandidates,
		);
		const streamError = Object.assign(new Error("rate limited after output"), {
			status: 429,
		});
		const provider = createStreamProvider(runtime, async function* () {
			yield "partial";
			throw streamError;
		});
		const output: string[] = [];
		assert.equal(await captureStream(provider, output), streamError);
		assert.deepEqual(output, ["partial"]);
		assert.deepEqual(runtime.acquire, [[]]);
		assert.equal(required(events[0], "first event")[2], streamError);
		assert.equal(
			events.some((event) => event[1] === "b"),
			false,
		);
	});

	test("does not switch accounts for a request-scoped pre-output error", async () => {
		const routeCandidates = routes();
		const events: unknown[][] = [];
		const firstRoute = required(routeCandidates[0], "first route");
		const secondRoute = required(routeCandidates[1], "second route");
		const runtime = streamRuntime(
			[
				streamLease("a", firstRoute, events),
				streamLease("b", secondRoute, events),
			],
			routeCandidates,
		);
		const requestError = Object.assign(new Error("model invalid for request"), {
			code: "invalid_model",
		});
		const provider = createStreamProvider(runtime, async function* () {
			yield* [];
			throw requestError;
		});
		const output: string[] = [];
		assert.equal(await captureStream(provider, output), requestError);
		assert.deepEqual(output, []);
		assert.deepEqual(runtime.acquire, [[]]);
		assert.equal(required(events[0], "first event")[2], requestError);
		assert.equal(
			events.some((event) => event[1] === "b"),
			false,
		);
	});
});
