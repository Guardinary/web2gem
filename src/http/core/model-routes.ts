import { VERSION } from "../../config";
import { MODELS } from "../../models";

const OPENAI_MODEL_LIST = Object.entries(MODELS).map(([n, c]) => ({
	id: n,
	object: "model",
	created: 1700000000,
	owned_by: "google",
	description: c.desc,
}));
const GOOGLE_MODEL_LIST = Object.entries(MODELS).map(([n, c]) => ({
	name: `models/${n}`,
	displayName: n,
	description: c.desc,
	supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
}));
const HEALTH_MODEL_IDS = Object.keys(MODELS);

export const OPENAI_MODEL_LIST_JSON = JSON.stringify({
	object: "list",
	data: OPENAI_MODEL_LIST,
});
export const OPENAI_MODEL_JSON_BY_ID = new Map(
	Object.entries(MODELS).map(([id, cfg]) => [
		id,
		JSON.stringify({
			id,
			object: "model",
			created: 1700000000,
			owned_by: "google",
			description: cfg.desc,
		}),
	]),
);
export const GOOGLE_MODEL_LIST_JSON = JSON.stringify({
	models: GOOGLE_MODEL_LIST,
});
export const GOOGLE_MODEL_JSON_BY_ID = new Map(
	GOOGLE_MODEL_LIST.map((model) => [model.displayName, JSON.stringify(model)]),
);
export const HEALTH_JSON = JSON.stringify({
	status: "ok",
	version: VERSION,
	models: HEALTH_MODEL_IDS,
});
export const NOT_FOUND_JSON = JSON.stringify({ error: "not found" });
