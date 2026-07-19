export async function* chunks<T>(
	items: readonly T[],
	throwAfter: number | null = null,
): AsyncGenerator<T> {
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (item !== undefined) yield item;
		if (throwAfter === index) throw new Error("stream broke");
	}
}
