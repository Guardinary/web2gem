export async function* chunks(items, throwAfter = null) {
	for (let index = 0; index < items.length; index++) {
		yield items[index];
		if (throwAfter === index) throw new Error("stream broke");
	}
}
