export function outputLine(...values) {
	writeLine(process.stdout, values);
}

export function errorLine(...values) {
	writeLine(process.stderr, values);
}

function writeLine(stream, values) {
	stream.write(`${values.map(formatValue).join(" ")}\n`);
}

function formatValue(value) {
	if (value instanceof Error) return value.stack || value.message;
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return String(value);
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch (_) {
			return String(value);
		}
	}
	return String(value);
}
