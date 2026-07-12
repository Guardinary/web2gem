export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workerCount = Math.max(
		1,
		Math.min(Math.floor(concurrency) || 1, items.length),
	);
	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) return;
			results[index] = await mapper(items[index] as T, index);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function mapWithConcurrencyAndWeight<T, R>(
	items: readonly T[],
	concurrency: number,
	maxWeight: number,
	weightOf: (item: T, index: number) => number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const limiter = createWeightLimiter(maxWeight);
	return mapWithConcurrency(items, concurrency, async (item, index) => {
		const release = await limiter.acquire(weightOf(item, index));
		try {
			return await mapper(item, index);
		} finally {
			release();
		}
	});
}

function createWeightLimiter(maxWeight: number) {
	const limit = Math.max(1, Math.floor(maxWeight) || 1);
	let activeWeight = 0;
	const queue: Array<{ weight: number; start: () => void }> = [];
	const drain = (): void => {
		while (true) {
			const next = queue[0];
			if (!next) return;
			if (activeWeight > 0 && activeWeight + next.weight > limit) return;
			queue.shift();
			activeWeight += next.weight;
			next.start();
		}
	};
	return {
		acquire(rawWeight: number): Promise<() => void> {
			const weight = Math.max(0, Math.floor(rawWeight) || 0);
			return new Promise((resolve) => {
				queue.push({
					weight,
					start: () => {
						let released = false;
						resolve(() => {
							if (released) return;
							released = true;
							activeWeight -= weight;
							drain();
						});
					},
				});
				drain();
			});
		},
	};
}
