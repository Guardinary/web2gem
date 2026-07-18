export function collectSSEData(writes) {
	return writes
		.join("")
		.split("\n\n")
		.filter(Boolean)
		.map((frame) => {
			const dataLine = frame
				.split("\n")
				.find((line) => line.startsWith("data: "));
			if (!dataLine) return null;
			const data = dataLine.slice("data: ".length);
			return data === "[DONE]" ? data : JSON.parse(data);
		})
		.filter((item) => item !== null);
}
