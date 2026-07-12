const prod = await import("../dist/worker.js");
const testMod = await import("../dist/worker.test.js");
const { readFile } = await import("node:fs/promises");
const { errorLine, outputLine } = await import("./io.mjs");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));

if (prod.VERSION !== `${packageJson.version}-worker`) {
	errorLine(
		`Smoke check failed: package version ${packageJson.version} does not match Worker version ${prod.VERSION}`,
	);
	process.exit(1);
}

const expectedProductionExports = [
	"MODELS",
	"VERSION",
	"default",
	"generate",
	"generateStream",
	"assertRuntimeConfig",
	"parseToolCalls",
	"resolveModel",
];

const productionExports = Object.keys(prod).sort();
const missingProductionExports = expectedProductionExports.filter(
	(name) => !productionExports.includes(name),
);
const unexpectedProductionExports = productionExports.filter(
	(name) => !expectedProductionExports.includes(name),
);
if (missingProductionExports.length || unexpectedProductionExports.length) {
	const details = [
		missingProductionExports.length
			? `missing: ${missingProductionExports.join(", ")}`
			: "",
		unexpectedProductionExports.length
			? `unexpected: ${unexpectedProductionExports.join(", ")}`
			: "",
	]
		.filter(Boolean)
		.join("; ");
	errorLine(
		`Smoke check failed: production bundle exports changed (${details})`,
	);
	process.exit(1);
}

const checks = [
	["default.fetch", prod.default && typeof prod.default.fetch === "function"],
	["MODELS", prod.MODELS && typeof prod.MODELS === "object"],
	["resolveModel", typeof prod.resolveModel === "function"],
	["assertRuntimeConfig", typeof prod.assertRuntimeConfig === "function"],
	["test.getConfig", typeof testMod.getConfig === "function"],
	["parseToolCalls", typeof prod.parseToolCalls === "function"],
	["test.buildPayload", typeof testMod.buildPayload === "function"],
	[
		"test.buildToolCallInstructions",
		typeof testMod.buildToolCallInstructions === "function",
	],
	[
		"test.normalizeResponsesInputAsMessages",
		typeof testMod.normalizeResponsesInputAsMessages === "function",
	],
];

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
	errorLine(`Smoke check failed: ${failed.join(", ")}`);
	process.exit(1);
}

const health = await prod.default.fetch(
	new Request("https://worker.example/"),
	{},
	{},
);
if (health.status !== 200) {
	errorLine(`Smoke check failed: health status ${health.status}`);
	process.exit(1);
}
const healthBody = await health.json();
if (healthBody.version !== prod.VERSION) {
	errorLine("Smoke check failed: health response version is stale");
	process.exit(1);
}

const preflight = await prod.default.fetch(
	new Request("https://worker.example/v1/chat/completions", {
		method: "OPTIONS",
		headers: {
			Origin: "https://client.example",
			"Access-Control-Request-Headers":
				"content-type, x-custom, x-ds2-internal-token",
			"Access-Control-Request-Private-Network": "true",
		},
	}),
	{},
	{},
);
if (preflight.status !== 204) {
	errorLine(`Smoke check failed: CORS preflight status ${preflight.status}`);
	process.exit(1);
}
if (
	preflight.headers.get("Access-Control-Allow-Origin") !==
	"https://client.example"
) {
	errorLine("Smoke check failed: CORS origin was not reflected");
	process.exit(1);
}
const allowHeaders =
	preflight.headers.get("Access-Control-Allow-Headers") || "";
if (
	!allowHeaders.includes("x-custom") ||
	/x-ds2-internal-token/i.test(allowHeaders)
) {
	errorLine("Smoke check failed: CORS allow headers filtering is incorrect");
	process.exit(1);
}

const authFailure = await prod.default.fetch(
	new Request("https://worker.example/v1/models"),
	{
		API_KEYS: "secret",
	},
	{},
);
if (authFailure.status !== 401) {
	errorLine(`Smoke check failed: auth failure status ${authFailure.status}`);
	process.exit(1);
}

const googleModel = await prod.default.fetch(
	new Request("https://worker.example/v1beta/models/gemini-3.5-flash"),
	{},
	{},
);
if (googleModel.status !== 200) {
	errorLine(
		`Smoke check failed: Google model detail status ${googleModel.status}`,
	);
	process.exit(1);
}
const googleModelBody = await googleModel.json();
if (
	googleModelBody.name !== "models/gemini-3.5-flash" ||
	googleModelBody.models
) {
	errorLine(
		"Smoke check failed: Google model detail did not return a single model",
	);
	process.exit(1);
}

const missingD1ForPro = await prod.default.fetch(
	new Request("https://worker.example/v1/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "gemini-3.1-pro",
			messages: [{ role: "user", content: "hello" }],
		}),
	}),
	{
		API_KEYS: "",
	},
	{},
);
if (missingD1ForPro.status !== 422) {
	errorLine(
		`Smoke check failed: missing D1 Pro status ${missingD1ForPro.status}`,
	);
	process.exit(1);
}
const missingD1Body = await missingD1ForPro.json();
if (
	missingD1Body.error?.code !== "gemini_authenticated_session_required" ||
	missingD1Body.error?.reason !== "pro_model"
) {
	errorLine(
		"Smoke check failed: missing D1 Pro did not return the authenticated-session error",
	);
	process.exit(1);
}

const unusedD1 = {
	prepare() {
		throw new Error("smoke validation should not read D1");
	},
};

const openAIReject = await prod.default.fetch(
	new Request("https://worker.example/v1/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "not-a-model",
			messages: [{ role: "user", content: "hello" }],
		}),
	}),
	{
		API_KEYS: "",
		CURRENT_INPUT_FILE_ENABLED: "false",
		GEMINI_DB: unusedD1,
	},
	{},
);
if (openAIReject.status !== 400) {
	errorLine(`Smoke check failed: OpenAI route status ${openAIReject.status}`);
	process.exit(1);
}
const openAIRejectBody = await openAIReject.json();
if (openAIRejectBody.error?.code !== "model_not_found") {
	errorLine("Smoke check failed: OpenAI route did not return model_not_found");
	process.exit(1);
}

const googleReject = await prod.default.fetch(
	new Request(
		"https://worker.example/v1beta/models/gemini-3.5-flash:generateContent",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ role: "user", parts: [{ text: "call a tool" }] }],
				toolConfig: { functionCallingConfig: { mode: "ANY" } },
			}),
		},
	),
	{
		API_KEYS: "",
		CURRENT_INPUT_FILE_ENABLED: "false",
		GEMINI_DB: unusedD1,
	},
	{},
);
if (googleReject.status !== 400) {
	errorLine(`Smoke check failed: Google route status ${googleReject.status}`);
	process.exit(1);
}
const googleRejectBody = await googleReject.json();
if (googleRejectBody.error?.code !== "invalid_tool_choice") {
	errorLine(
		"Smoke check failed: Google route did not return invalid_tool_choice",
	);
	process.exit(1);
}

const toolInstructions = testMod.buildToolCallInstructions(["Read"]);
if (!toolInstructions.includes("Read-tool cache guard")) {
	errorLine(
		"Smoke check failed: buildToolCallInstructions did not render read-tool guard",
	);
	process.exit(1);
}

const [, toolCalls] = prod.parseToolCalls(
	'<|DSML|tool_calls><|DSML|invoke name="Read"><|DSML|parameter name="file_path"><![CDATA[README.md]]></|DSML|parameter></|DSML|invoke></|DSML|tool_calls>',
);
if (!toolCalls.length || toolCalls[0].function.name !== "Read") {
	errorLine("Smoke check failed: parseToolCalls did not parse DSML tool call");
	process.exit(1);
}

outputLine("Smoke check passed");
