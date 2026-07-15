export type GoogleGenerationRoute = {
	modelName: string;
	stream: boolean;
};

const GOOGLE_MODEL_PREFIXES = ["/v1beta/models/", "/v1/models/"] as const;
const GOOGLE_GENERATION_ACTIONS = [
	{ suffix: ":streamGenerateContent", stream: true },
	{ suffix: ":generateContent", stream: false },
] as const;

export function parseGoogleGenerationPath(
	path: string,
): GoogleGenerationRoute | null {
	const prefix = GOOGLE_MODEL_PREFIXES.find((candidate) =>
		path.startsWith(candidate),
	);
	if (!prefix) return null;
	const action = GOOGLE_GENERATION_ACTIONS.find((candidate) =>
		path.endsWith(candidate.suffix),
	);
	if (!action) return null;
	const encodedModelName = path.slice(
		prefix.length,
		path.length - action.suffix.length,
	);
	if (!encodedModelName || encodedModelName.includes("/")) return null;
	try {
		const modelName = decodeURIComponent(encodedModelName);
		if (!modelName || modelName.includes("/")) return null;
		return { modelName, stream: action.stream };
	} catch {
		return null;
	}
}
