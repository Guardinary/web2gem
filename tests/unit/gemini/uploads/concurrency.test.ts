import { describe, test } from "vitest";
import { mapWithConcurrencyAndWeight } from "../../../../src/gemini/concurrency";
import { assert } from "../../assertions.js";
import { deferred, type Deferred } from "../../_support/deferred.js";

function requiredDeferred<T>(items: readonly Deferred<T>[], index: number) {
	const item = items[index];
	if (!item) throw new Error(`missing deferred ${index}`);
	return item;
}

describe("weighted upload concurrency", () => {
	test("limits active mapper count independently of weight", async () => {
		const started = Array.from({ length: 4 }, deferred);
		const release = Array.from({ length: 4 }, deferred);
		const startedFlags = [false, false, false, false];
		let activeCount = 0;
		let maxActiveCount = 0;

		const operation = mapWithConcurrencyAndWeight(
			[0, 1, 2, 3],
			2,
			10,
			() => 1,
			async (value, index) => {
				startedFlags[index] = true;
				activeCount += 1;
				maxActiveCount = Math.max(maxActiveCount, activeCount);
				requiredDeferred(started, index).resolve();
				await requiredDeferred(release, index).promise;
				activeCount -= 1;
				return value;
			},
		);

		await Promise.all([
			requiredDeferred(started, 0).promise,
			requiredDeferred(started, 1).promise,
		]);
		assert.deepEqual(startedFlags, [true, true, false, false]);
		requiredDeferred(release, 0).resolve();
		await requiredDeferred(started, 2).promise;
		assert.deepEqual(startedFlags, [true, true, true, false]);
		requiredDeferred(release, 1).resolve();
		await requiredDeferred(started, 3).promise;
		requiredDeferred(release, 2).resolve();
		requiredDeferred(release, 3).resolve();

		assert.deepEqual(await operation, [0, 1, 2, 3]);
		assert.equal(maxActiveCount, 2);
	});

	test("bounds aggregate weight and preserves result order", async () => {
		const started = Array.from({ length: 3 }, deferred);
		const release = Array.from({ length: 3 }, deferred);
		const startedFlags = [false, false, false];
		let activeWeight = 0;
		let maxActiveWeight = 0;

		const operation = mapWithConcurrencyAndWeight(
			[6, 4, 6],
			3,
			10,
			(value) => value,
			async (value, index) => {
				startedFlags[index] = true;
				activeWeight += value;
				maxActiveWeight = Math.max(maxActiveWeight, activeWeight);
				requiredDeferred(started, index).resolve();
				await requiredDeferred(release, index).promise;
				activeWeight -= value;
				return `result-${index}`;
			},
		);

		await Promise.all([
			requiredDeferred(started, 0).promise,
			requiredDeferred(started, 1).promise,
		]);
		assert.deepEqual(startedFlags, [true, true, false]);
		requiredDeferred(release, 0).resolve();
		await requiredDeferred(started, 2).promise;
		assert.deepEqual(startedFlags, [true, true, true]);
		requiredDeferred(release, 1).resolve();
		requiredDeferred(release, 2).resolve();

		assert.deepEqual(await operation, ["result-0", "result-1", "result-2"]);
		assert.equal(maxActiveWeight, 10);
	});

	test("admits FIFO items and runs an oversized item alone", async () => {
		const weights = [6, 6, 12, 4];
		const started = weights.map(deferred);
		const release = weights.map(deferred);
		const startedFlags = weights.map(() => false);
		let activeWeight = 0;
		let maxActiveWeight = 0;

		const operation = mapWithConcurrencyAndWeight(
			weights,
			4,
			10,
			(value) => value,
			async (value, index) => {
				startedFlags[index] = true;
				activeWeight += value;
				maxActiveWeight = Math.max(maxActiveWeight, activeWeight);
				requiredDeferred(started, index).resolve();
				await requiredDeferred(release, index).promise;
				activeWeight -= value;
				return index;
			},
		);

		await requiredDeferred(started, 0).promise;
		assert.deepEqual(startedFlags, [true, false, false, false]);
		requiredDeferred(release, 0).resolve();
		await requiredDeferred(started, 1).promise;
		assert.deepEqual(startedFlags, [true, true, false, false]);
		requiredDeferred(release, 1).resolve();
		await requiredDeferred(started, 2).promise;
		assert.deepEqual(startedFlags, [true, true, true, false]);
		assert.equal(activeWeight, 12);
		requiredDeferred(release, 2).resolve();
		await requiredDeferred(started, 3).promise;
		requiredDeferred(release, 3).resolve();

		assert.deepEqual(await operation, [0, 1, 2, 3]);
		assert.equal(maxActiveWeight, 12);
	});

	test("releases weight after mapper errors without abandoning queued work", async () => {
		const firstStarted = deferred();
		const secondStarted = deferred();
		const releaseSecond = deferred();
		const secondCompleted = deferred();
		const starts: number[] = [];

		const operation = mapWithConcurrencyAndWeight(
			[12, 4],
			2,
			10,
			(value) => value,
			async (_value, index) => {
				starts.push(index);
				if (index === 0) {
					firstStarted.resolve();
					throw new Error("weighted mapper failed");
				}
				secondStarted.resolve();
				await releaseSecond.promise;
				secondCompleted.resolve();
			},
		);

		await firstStarted.promise;
		await assert.rejects(operation, /weighted mapper failed/);
		await secondStarted.promise;
		releaseSecond.resolve();
		await secondCompleted.promise;
		assert.deepEqual(starts, [0, 1]);
	});
});
