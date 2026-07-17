import { describe, test } from "vitest";
import { basicRouteForFamily } from "../../../src/gemini/accounts/routes";
import { createGeminiCompletionProvider } from "../../../src/gemini/completion-provider";
import { assert } from "../assertions.js";
import { baseGeminiClientConfig } from "./_support/client-fixtures.js";

function proModel() {
	return {
		name: "gemini-3.1-pro",
		family: "pro",
		extended: false,
		dynamicProviderId: null,
	};
}

function routes() {
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

function streamLease(accountId, selectedRoute, events) {
	const config = baseGeminiClientConfig({
		cookie: `__Secure-1PSID=psid-${accountId}`,
		gemini_account: {
			accountId,
			rowId: `row-${accountId}`,
			cookieHash: `hash-${accountId}`,
		},
	});
	let released = false;
	return {
		accountId,
		rowId: config.gemini_account.rowId,
		selectedCookieHash: config.gemini_account.cookieHash,
		selectedRoute,
		modelCapability: null,
		config,
		async recordPageState() {
			throw new Error("unexpected lease.recordPageState call");
		},
		async refreshForRetry() {
			throw new Error("unexpected lease.refreshForRetry call");
		},
		async markSuccess() {
			events.push(["markSuccess", accountId]);
		},
		async markFailure(error) {
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

function streamRuntime(leases, routeCandidates) {
	const pending = [...leases];
	const acquire = [];
	return {
		acquire,
		async resolveModel() {
			throw new Error("unexpected runtime.resolveModel call");
		},
		async routeCandidatesForModel() {
			return routeCandidates;
		},
		async acquireLease(_base, options) {
			acquire.push([...(options.excludeAccountIds || [])]);
			if (!pending.length)
				throw new Error("unexpected extra account acquisition");
			return pending.shift();
		},
	};
}

function createStreamProvider(runtime, generateStream) {
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

async function captureStream(provider, output) {
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
		const events = [];
		const runtime = streamRuntime(
			[
				streamLease("a", routeCandidates[0], events),
				streamLease("b", routeCandidates[1], events),
			],
			routeCandidates,
		);
		const firstError = Object.assign(new Error("rate limited a"), {
			status: 429,
		});
		const calls = [];
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
				const accountId = activeCfg.gemini_account.accountId;
				calls.push([
					accountId,
					modelNumber,
					JSON.parse(headers["x-goog-ext-525001261-jspb"])[4],
				]);
				if (accountId === "a") throw firstError;
				yield "account b";
			},
		);
		const output = [];
		assert.equal(await captureStream(provider, output), null);
		assert.deepEqual(output, ["account b"]);
		assert.deepEqual(calls, [
			["a", routeCandidates[0].modelNumber, routeCandidates[0].providerModelId],
			["b", routeCandidates[1].modelNumber, routeCandidates[1].providerModelId],
		]);
		assert.deepEqual(runtime.acquire, [[], ["a"]]);
		assert.equal(events[0][2], firstError);
	});

	test("pins a stream to the selected account after visible output", async () => {
		const routeCandidates = routes();
		const events = [];
		const runtime = streamRuntime(
			[
				streamLease("a", routeCandidates[0], events),
				streamLease("b", routeCandidates[1], events),
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
		const output = [];
		assert.equal(await captureStream(provider, output), streamError);
		assert.deepEqual(output, ["partial"]);
		assert.deepEqual(runtime.acquire, [[]]);
		assert.equal(events[0][2], streamError);
		assert.equal(
			events.some((event) => event[1] === "b"),
			false,
		);
	});

	test("does not switch accounts for a request-scoped pre-output error", async () => {
		const routeCandidates = routes();
		const events = [];
		const runtime = streamRuntime(
			[
				streamLease("a", routeCandidates[0], events),
				streamLease("b", routeCandidates[1], events),
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
		const output = [];
		assert.equal(await captureStream(provider, output), requestError);
		assert.deepEqual(output, []);
		assert.deepEqual(runtime.acquire, [[]]);
		assert.equal(events[0][2], requestError);
		assert.equal(
			events.some((event) => event[1] === "b"),
			false,
		);
	});
});
