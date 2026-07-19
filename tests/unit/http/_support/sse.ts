export function collectSSEData(writes: readonly string[]): unknown[] {
	return writes
		.join("")
		.split("\n\n")
		.filter(Boolean)
		.map((frame): unknown => {
			const dataLine = frame
				.split("\n")
				.find((line) => line.startsWith("data: "));
			if (!dataLine) return null;
			const data = dataLine.slice("data: ".length);
			return data === "[DONE]" ? data : JSON.parse(data);
		})
		.filter((item) => item !== null);
}
