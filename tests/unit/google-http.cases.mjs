import { assert } from "./assertions.js";
import {
	attachmentResult,
	baseConfig,
	chunks,
	collectSSEData,
	fakeProvider,
	fakeStreamProvider,
	mod,
	resolvedModel,
	streamError,
	withConsoleLog,
} from "./helpers.js";

export const suiteName = "google http";
export const cases = [
	[
		"rejects invalid Google model before provider generation",
		async () => {
			let generated = false;
			const provider = {
				async generateText() {
					generated = true;
					return "done";
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleGoogleGenerate(
				{
					contents: [{ role: "user", parts: [{ text: "plain request" }] }],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					current_input_file_name: "message.txt",
					current_tools_file_name: "tools.txt",
					cookie: "",
					log_requests: false,
				},
				provider,
				"/v1beta/models/not-a-model:generateContent",
				false,
			);
			assert.equal(resp.status, 400);
			const body = await resp.json();
			assert.equal(body.error.code, "model_not_found");
			assert.equal(generated, false);
		},
	],
	[
		"adds DSML tool instructions for Google function declarations",
		async () => {
			const prompts = [];
			const provider = {
				async generateText(input) {
					prompts.push(input.prompt);
					return '<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>';
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleGoogleGenerate(
				{
					contents: [{ role: "user", parts: [{ text: "read the file" }] }],
					tools: [
						{
							functionDeclarations: [
								{
									name: "Read",
									description: "Read a file",
									parameters: {
										type: "object",
										properties: { path: { type: "string" } },
									},
								},
							],
						},
					],
					toolConfig: { functionCallingConfig: { mode: "ANY" } },
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					current_input_file_name: "message.txt",
					current_tools_file_name: "tools.txt",
					cookie: "",
					log_requests: false,
				},
				provider,
				"/v1beta/models/gemini-3.5-flash:generateContent",
				false,
			);
			assert.equal(resp.status, 200);
			assert.match(prompts[0], /Available tools/);
			assert.match(prompts[0], /<\|DSML\|tool_calls>/);
			assert.match(prompts[0], /"name": "Read"/);
			assert.match(prompts[0], /"path"/);
		},
	],
	[
		"adds DSML tool instructions for wrapped Google function declarations",
		async () => {
			const prompts = [];
			const provider = {
				async generateText(input) {
					prompts.push(input.prompt);
					return '<tool_calls><invoke name="Lookup"><parameter name="id">abc</parameter></invoke></tool_calls>';
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleGoogleGenerate(
				{
					contents: [{ role: "user", parts: [{ text: "lookup id" }] }],
					tools: {
						functionDeclarations: [
							{
								name: "Lookup",
								description: "Lookup by id",
								parameters: {
									type: "object",
									properties: { id: { type: "string" } },
								},
							},
						],
					},
					toolConfig: { functionCallingConfig: { mode: "ANY" } },
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					current_input_file_name: "message.txt",
					current_tools_file_name: "tools.txt",
					cookie: "",
					log_requests: false,
				},
				provider,
				"/v1beta/models/gemini-3.5-flash:generateContent",
				false,
			);
			assert.equal(resp.status, 200);
			assert.match(prompts[0], /Available tools/);
			assert.match(prompts[0], /<\|DSML\|tool_calls>/);
			assert.match(prompts[0], /"name": "Lookup"/);
		},
	],
	[
		"keeps Google image refs before context refs while appending generic refs",
		async () => {
			const provider = fakeProvider({
				async resolveAttachments() {
					return attachmentResult({
						fileRefs: [
							{ ref: "/uploaded/image", name: "image.png" },
							{ ref: "/uploaded/file", name: "note.txt" },
						],
						imageFileRefs: [{ ref: "/uploaded/image", name: "image.png" }],
						genericFileRefs: [{ ref: "/uploaded/file", name: "note.txt" }],
					});
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			});
			const result = await mod.prepareGoogleGeminiContext(
				baseConfig({
					current_input_file_enabled: true,
					current_input_file_min_bytes: 10,
					cookie: "SID=ok",
					supports_authenticated_session: true,
				}),
				provider,
				{
					contents: [
						{
							role: "user",
							parts: [
								{ text: `please inspect ${"x".repeat(80)}` },
								{ inlineData: { data: "AAAA", mimeType: "image/png" } },
								{
									inlineData: {
										data: "bm90ZQ==",
										mimeType: "text/plain",
										displayName: "note.txt",
									},
								},
							],
						},
					],
				},
				false,
			);

			assert.equal(result.error, undefined);
			assert.deepEqual(result.fileRefs, [
				{ ref: "/uploaded/image", name: "image.png" },
				{ ref: "/uploaded/message.txt", name: "message.txt" },
				{ ref: "/uploaded/tools.txt", name: "tools.txt" },
				{ ref: "/uploaded/file", name: "note.txt" },
			]);
		},
	],
	[
		"filters Google OpenAI-style function tools by config",
		async () => {
			const cfg = {
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "",
				log_requests: false,
			};
			const req = {
				contents: [{ role: "user", parts: [{ text: "call read" }] }],
				tools: [
					{
						type: "function",
						function: {
							name: "Read",
							description: "Read a file",
							parameters: {
								type: "object",
								properties: { path: { type: "string" } },
							},
						},
					},
				],
				toolConfig: { functionCallingConfig: { mode: "ANY" } },
			};
			const filtered = mod.filterGoogleToolsByConfig(req.tools, req);
			assert.equal(filtered[0].function.name, "Read");
			const result = await mod.prepareGoogleGeminiContext(
				cfg,
				fakeStreamProvider([]),
				{ ...req, tools: filtered },
				true,
			);
			assert.equal(result.error, undefined);
			assert.match(result.prompt, /Available tools/);
			assert.match(result.prompt, /"name": "Read"/);
			assert.match(result.prompt, /"path"/);
		},
	],
	[
		"filters Google schema shorthand tools by config",
		async () => {
			const cfg = {
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "",
				log_requests: false,
			};
			const req = {
				contents: [{ role: "user", parts: [{ text: "call lookup" }] }],
				tools: [
					{
						name: "Lookup",
						description: "Lookup by id",
						schema: { type: "object", properties: { id: { type: "string" } } },
					},
				],
				toolConfig: { functionCallingConfig: { mode: "ANY" } },
			};
			const filtered = mod.filterGoogleToolsByConfig(req.tools, req);
			assert.equal(filtered[0].function.name, "Lookup");
			const result = await mod.prepareGoogleGeminiContext(
				cfg,
				fakeStreamProvider([]),
				{ ...req, tools: filtered },
				true,
			);
			assert.equal(result.error, undefined);
			assert.match(result.prompt, /"name": "Lookup"/);
			assert.match(result.prompt, /"id"/);
		},
	],
	[
		"filters Google functionDeclarations arrays by config",
		async () => {
			const cfg = {
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "",
				log_requests: false,
			};
			const req = {
				contents: [{ role: "user", parts: [{ text: "call fetch" }] }],
				tools: [
					{
						functionDeclarations: [
							{
								name: "Fetch",
								description: "Fetch by URL",
								parameters: {
									type: "object",
									properties: { url: { type: "string" } },
								},
							},
						],
					},
				],
				toolConfig: { functionCallingConfig: { mode: "ANY" } },
			};
			const filtered = mod.filterGoogleToolsByConfig(req.tools, req);
			assert.equal(filtered[0].function.name, "Fetch");
			const result = await mod.prepareGoogleGeminiContext(
				cfg,
				fakeStreamProvider([]),
				{ ...req, tools: filtered },
				true,
			);
			assert.equal(result.error, undefined);
			assert.match(result.prompt, /"name": "Fetch"/);
			assert.match(result.prompt, /"url"/);
		},
	],
	[
		"filters Google functions arrays with parametersJsonSchema",
		async () => {
			const cfg = {
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "",
				log_requests: false,
			};
			const req = {
				contents: [{ role: "user", parts: [{ text: "call translate" }] }],
				tools: [
					{
						functions: [
							{
								name: "Translate",
								description: "Translate text",
								parametersJsonSchema: {
									type: "object",
									properties: { text: { type: "string" } },
								},
							},
						],
					},
				],
				toolConfig: { functionCallingConfig: { mode: "ANY" } },
			};
			const filtered = mod.filterGoogleToolsByConfig(req.tools, req);
			assert.equal(filtered[0].function.name, "Translate");
			const result = await mod.prepareGoogleGeminiContext(
				cfg,
				fakeStreamProvider([]),
				{ ...req, tools: filtered },
				true,
			);
			assert.equal(result.error, undefined);
			assert.match(result.prompt, /"name": "Translate"/);
			assert.match(result.prompt, /"text"/);
		},
	],
	[
		"keeps Google legacy function-call syntaxes as plain text",
		async () => {
			const tools = [
				{
					functionDeclarations: [
						{
							name: "Lookup",
							parameters: {
								type: "object",
								properties: {
									id: { type: "integer" },
									query: { type: "string" },
								},
							},
						},
					],
				},
			];
			const [cleanFence, fenceCalls] = mod.parseGoogleFunctionCalls(
				'before\n```function_call\n{"name":"Lookup","arguments":{"id":"7","query":"alpha"}}\n```\nafter',
				tools,
			);
			assert.match(cleanFence, /```function_call/);
			assert.deepEqual(fenceCalls, []);

			const [cleanBare, bareCalls] = mod.parseGoogleFunctionCalls(
				'{"name":"Lookup","input":{"id":"8","query":"beta"}}',
				tools,
			);
			assert.equal(
				cleanBare,
				'{"name":"Lookup","input":{"id":"8","query":"beta"}}',
			);
			assert.deepEqual(bareCalls, []);

			const [_cleanDsml, dsmlCalls] = mod.parseGoogleFunctionCalls(
				'<tool_calls><invoke name="Lookup"><parameter name="query"><term>docs</term></parameter></invoke></tool_calls>',
				tools,
			);
			assert.equal(dsmlCalls[0].args.query, '{"term":"docs"}');
		},
	],
	[
		"keeps malformed Google function-call text as plain output",
		async () => {
			const [clean, calls] = mod.parseGoogleFunctionCalls(
				'before\n```function_call\n{"name":\n```\nafter',
				null,
			);
			assert.match(clean, /before/);
			assert.match(clean, /```function_call/);
			assert.match(clean, /\{"name":/);
			assert.match(clean, /after/);
			assert.deepEqual(calls, []);
		},
	],
	[
		"validates Google tool-choice mode and allowed-name aliases",
		async () => {
			const tools = [
				{
					functionDeclarations: [
						{ name: "Read", parameters: { type: "object" } },
					],
				},
			];
			assert.equal(
				mod.validateGoogleToolChoiceConfig(
					{
						tools,
						tool_config: {
							function_calling_config: {
								mode: "auto",
								allowed_function_names: "Read",
							},
						},
					},
					tools,
				),
				null,
			);
			assert.equal(
				mod.parseGoogleToolChoicePolicy(
					{
						tool_config: {
							function_calling_config: {
								mode: "ANY",
								allowed_function_names: "Read",
							},
						},
					},
					tools,
				).mode,
				"required",
			);
			assert.match(
				mod.validateGoogleToolChoiceConfig(
					{
						tools,
						toolConfig: { functionCallingConfig: { mode: "NEVER" } },
					},
					tools,
				).message,
				/unsupported functionCallingConfig\.mode/,
			);
			assert.match(
				mod.validateGoogleToolChoiceConfig(
					{
						tools,
						toolConfig: {
							functionCallingConfig: {
								mode: "AUTO",
								allowedFunctionNames: ["Missing"],
							},
						},
					},
					tools,
				).message,
				/allowed unknown function: Missing/,
			);
			assert.match(
				mod.validateGoogleFunctionCalls(
					{
						tools,
						toolConfig: { functionCallingConfig: { mode: "NONE" } },
					},
					[{ name: "Read", args: {} }],
				).message,
				/does not allow function\(s\): Read/,
			);
		},
	],
	[
		"omits Google tools when function calling mode is NONE",
		async () => {
			const filtered = mod.filterGoogleToolsByConfig(
				[
					{
						functionDeclarations: [
							{ name: "Read", parameters: { type: "object" } },
						],
					},
				],
				{
					toolConfig: { functionCallingConfig: { mode: "NONE" } },
				},
			);
			assert.equal(filtered, null);
		},
	],
	[
		"rejects Google ANY tool choice when no tools are declared",
		async () => {
			const resp = await mod.default.fetch(
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
					LOG_REQUESTS: "false",
					GEMINI_DB: {
						prepare() {
							throw new Error("invalid tool choice should not read D1");
						},
					},
				},
				{},
			);
			assert.equal(resp.status, 400);
			const body = await resp.json();
			assert.equal(body.error.code, "invalid_tool_choice");
			assert.match(body.error.message, /mode=ANY requires at least one tool/);
		},
	],
	[
		"rejects Google plain answer when ANY requires a tool call",
		async () => {
			const tools = [
				{
					functionDeclarations: [
						{ name: "Read", parameters: { type: "object" } },
					],
				},
			];
			const effectiveReq = {
				tools,
				toolConfig: { functionCallingConfig: { mode: "ANY" } },
			};
			const finalized = mod.finalizeGoogleCompletionResult("plain answer", {
				effectiveReq,
				effectiveGoogleTools: tools,
				hasTools: true,
			});
			assert.equal(finalized.error.status, 422);
			assert.equal(finalized.error.code, "tool_choice_violation");
		},
	],
	[
		"emits Google tool stream policy violation instead of candidate text",
		async () => {
			const tools = [
				{
					functionDeclarations: [
						{ name: "Read", parameters: { type: "object" } },
					],
				},
			];
			const events = [];
			for await (const event of mod.streamGoogleToolCompletionEvents(
				fakeStreamProvider(["plain answer"]),
				{
					prompt: "must call a tool",
					rm: { name: "gemini-3.5-flash" },
					fileRefs: null,
					tools,
					effectiveReq: {
						tools,
						toolConfig: { functionCallingConfig: { mode: "ANY" } },
					},
					promptTokens: 1,
					signal: new AbortController().signal,
				},
			)) {
				events.push(event);
			}
			assert.equal(
				events.some((event) => event.type === "tool_policy_violation"),
				true,
			);
			assert.equal(
				events.some(
					(event) =>
						event.type === "candidate" &&
						JSON.stringify(event.parts || "").includes("mode=ANY requires"),
				),
				false,
			);
		},
	],
	[
		"emits Google tool stream protocol error before any output",
		async () => {
			const events = [];
			for await (const event of mod.streamGoogleToolCompletionEvents(
				fakeProvider({
					streamText() {
						throw streamError("upstream down", "upstream_down");
					},
				}),
				{
					prompt: "must answer",
					rm: { name: "gemini-3.5-flash" },
					fileRefs: null,
					tools: null,
					effectiveReq: {},
					promptTokens: 2,
					signal: new AbortController().signal,
				},
			)) {
				events.push(event);
			}
			assert.equal(events[0].type, "error");
			assert.equal(events[0].error.code, "upstream_down");
			assert.equal(events.length, 1);
		},
	],
	[
		"emits Google tool stream warning after partial plain output",
		async () => {
			const events = [];
			for await (const event of mod.streamGoogleToolCompletionEvents(
				fakeProvider({
					streamText() {
						return chunks(["partial answer"], 0);
					},
				}),
				{
					prompt: "partial",
					rm: { name: "gemini-3.5-flash" },
					fileRefs: null,
					tools: null,
					effectiveReq: {},
					promptTokens: 3,
					signal: new AbortController().signal,
				},
			)) {
				events.push(event);
			}
			assert.equal(
				events.some(
					(event) =>
						event.type === "candidate" &&
						event.parts[0].text === "partial answer",
				),
				true,
			);
			const warning = events.find((event) => event.type === "warning");
			assert.equal(warning.error.message, "stream broke");
			assert.equal(
				events.some(
					(event) =>
						event.type === "candidate" &&
						String(event.parts[0].text || "").includes(
							"stream interrupted after partial output",
						),
				),
				false,
			);
		},
	],
	[
		"emits Google tool stream warning before parsed function calls",
		async () => {
			const tools = [
				{
					functionDeclarations: [
						{ name: "Read", parameters: { type: "object" } },
					],
				},
			];
			const events = [];
			for await (const event of mod.streamGoogleToolCompletionEvents(
				fakeProvider({
					streamText() {
						return chunks(
							[
								'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
							],
							0,
						);
					},
				}),
				{
					prompt: "read",
					rm: { name: "gemini-3.5-flash" },
					fileRefs: null,
					tools,
					effectiveReq: { tools },
					promptTokens: 4,
					signal: new AbortController().signal,
				},
			)) {
				events.push(event);
			}
			assert.equal(
				events.some((event) => event.type === "warning"),
				true,
			);
			const callEvent = events.find(
				(event) =>
					event.type === "candidate" &&
					event.parts &&
					event.parts[0].functionCall,
			);
			assert.equal(callEvent.parts[0].functionCall.name, "Read");
			assert.equal(callEvent.parts[0].functionCall.args.path, "README.md");
		},
	],
	[
		"moves large Google tools into attached tools file",
		async () => {
			const prompts = [];
			const uploads = [];
			const provider = {
				async generateText(input) {
					prompts.push(input.prompt);
					return "done";
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(text, filename) {
					uploads.push({ text, filename });
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleGoogleGenerate(
				{
					contents: [
						{ role: "user", parts: [{ text: `lookup id ${"x".repeat(120)}` }] },
					],
					tools: [
						{
							functionDeclarations: [
								{
									name: "Lookup",
									description: "Lookup by id",
									parameters: {
										type: "object",
										properties: { id: { type: "string" } },
									},
								},
							],
						},
					],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: true,
					current_input_file_min_bytes: 40,
					current_input_file_name: "message.txt",
					current_tools_file_name: "tools.txt",
					cookie: "SID=ok",
					supports_authenticated_session: true,
					log_requests: false,
				},
				provider,
				"/v1beta/models/gemini-3.5-flash:generateContent",
				false,
			);
			assert.equal(resp.status, 200);
			assert.equal(uploads.length, 2);
			assert.doesNotMatch(prompts[0], /<\|DSML\|tool_calls>/);
			assert.match(
				prompts[0],
				/Continue from the latest state in the attached `message\.txt` context/,
			);
			assert.match(prompts[0], /tools\.txt/);
			assert.match(
				prompts[0],
				/All text above this sentence is system prompt content/,
			);
			assert.doesNotMatch(prompts[0], /Gemini native hidden tool calls/);
			assert.doesNotMatch(prompts[0], /Available tools/);
			assert.doesNotMatch(prompts[0], /"name": "Lookup"|"properties"/);
			assert.match(uploads[1].text, /Available tool descriptions/);
			assert.match(uploads[1].text, /Tool call format instructions/);
			assert.match(uploads[1].text, /<\|DSML\|tool_calls>/);
			assert.match(uploads[1].text, /Gemini native hidden tool calls/);
			assert.match(uploads[1].text, /"name": "Lookup"/);
			assert.match(uploads[1].text, /"id"/);
		},
	],
	[
		"omits tool instructions for plain Google requests",
		async () => {
			const prompts = [];
			const provider = {
				async generateText(input) {
					prompts.push(input.prompt);
					return "done";
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleGoogleGenerate(
				{
					contents: [{ role: "user", parts: [{ text: "plain request" }] }],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					current_input_file_name: "message.txt",
					current_tools_file_name: "tools.txt",
					cookie: "",
					log_requests: false,
				},
				provider,
				"/v1beta/models/gemini-3.5-flash:generateContent",
				false,
			);
			assert.equal(resp.status, 200);
			assert.doesNotMatch(prompts[0], /<\|DSML\|tool_calls>/);
			assert.doesNotMatch(prompts[0], /Available tools/);
		},
	],
	[
		"converts Google system image function call and function response parts",
		async () => {
			const prompts = [];
			const provider = {
				async generateText(input) {
					prompts.push(input.prompt);
					return "done";
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleGoogleGenerate(
				{
					systemInstruction: { parts: [{ text: "be concise" }] },
					contents: [
						{
							role: "user",
							parts: [
								{ text: "inspect image" },
								{ inlineData: { data: "AAAA", mimeType: "image/png" } },
							],
						},
						{
							role: "model",
							parts: [
								{ functionCall: { name: "Lookup", args: { id: "abc" } } },
							],
						},
						{
							role: "user",
							parts: [
								{
									functionResponse: { name: "Lookup", response: { ok: true } },
								},
							],
						},
					],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					current_input_file_name: "message.txt",
					current_tools_file_name: "tools.txt",
					cookie: "",
					log_requests: false,
				},
				provider,
				"/v1beta/models/gemini-3.5-flash:generateContent",
				false,
			);
			assert.equal(resp.status, 200);
			assert.match(prompts[0], /\[System instruction\]: be concise/);
			assert.match(prompts[0], /inspect image/);
			assert.match(prompts[0], /\[image input\]/);
			assert.match(
				prompts[0],
				/\[Assistant\]: \n<\|DSML\|tool_calls><\|DSML\|invoke name="Lookup">/,
			);
			assert.match(prompts[0], /\[Tool result for Lookup\]: \{"ok":true\}/);
		},
	],
	[
		"maps invalid Gemini cookie errors to Google auth responses",
		async () => {
			const err = mod.invalidGeminiCookieError({ cookie: "SID=bad" }, 403, 10);
			const provider = {
				async generateText() {
					throw err;
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleGoogleGenerate(
				{
					contents: [{ role: "user", parts: [{ text: "plain request" }] }],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					current_input_file_name: "message.txt",
					current_tools_file_name: "tools.txt",
					cookie: "SID=bad",
					log_requests: false,
				},
				provider,
				"/v1beta/models/gemini-3.5-flash:generateContent",
				false,
			);
			assert.equal(resp.status, 401);
			const body = await resp.json();
			assert.equal(body.error.code, "invalid_gemini_cookie");
		},
	],
	[
		"maps non-stream Google upstream errors to Google error envelopes",
		async () => {
			const err = streamError(
				"google overloaded secret",
				"upstream_overloaded",
			);
			err.status = 503;
			const logs = [];
			const resp = await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.handleGoogleGenerate(
						{
							contents: [{ role: "user", parts: [{ text: "plain request" }] }],
						},
						{
							default_model: "gemini-3.5-flash",
							current_input_file_enabled: false,
							current_input_file_min_bytes: 1000000,
							current_input_file_name: "message.txt",
							current_tools_file_name: "tools.txt",
							cookie: "",
							log_requests: true,
						},
						fakeProvider({
							async generateText() {
								throw err;
							},
						}),
						"/v1beta/models/gemini-3.5-flash:generateContent",
						false,
					),
			);
			assert.equal(resp.status, 503);
			const body = await resp.json();
			assert.equal(body.error.code, "upstream_overloaded");
			assert.match(
				body.error.message,
				/upstream error: google overloaded secret/,
			);
			const failureLog = logs.find((line) =>
				line.includes("google generate failed"),
			);
			assert.match(
				failureLog,
				/error=type=Error code=upstream_overloaded status=503/,
			);
			assert.doesNotMatch(failureLog, /google overloaded secret/);
		},
	],
	[
		"returns Google upstream_empty error without fallback candidate",
		async () => {
			const resp = await mod.handleGoogleGenerate(
				{
					contents: [{ role: "user", parts: [{ text: "plain request" }] }],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					current_input_file_name: "message.txt",
					current_tools_file_name: "tools.txt",
					cookie: "",
					log_requests: false,
				},
				fakeProvider({
					async generateText() {
						return "";
					},
				}),
				"/v1beta/models/gemini-3.5-flash:generateContent",
				false,
			);
			assert.equal(resp.status, 502);
			const body = await resp.json();
			assert.equal(body.error.code, "upstream_empty");
			assert.equal(body.error.message, mod.EMPTY_UPSTREAM_MSG);
			assert.equal(body.candidates, undefined);
		},
	],
	[
		"streams Google plain responses through generate handler",
		async () => {
			const logs = [];
			let resp;
			let body = "";
			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					resp = await mod.handleGoogleGenerate(
						{
							contents: [{ role: "user", parts: [{ text: "say hi" }] }],
						},
						{
							default_model: "gemini-3.5-flash",
							current_input_file_enabled: false,
							current_input_file_min_bytes: 1000000,
							current_input_file_name: "message.txt",
							current_tools_file_name: "tools.txt",
							cookie: "",
							log_requests: true,
						},
						fakeStreamProvider(["he", "llo"]),
						"/v1beta/models/gemini-3.5-flash:streamGenerateContent",
						true,
					);
					body = await resp.text();
				},
			);
			assert.equal(resp.status, 200);
			assert.match(body, /"text":"he"/);
			assert.match(body, /"text":"llo"/);
			assert.match(body, /"finishReason":"STOP"/);
			assert.equal(
				logs.some((line) => line.includes("stage=google_prepare")),
				true,
			);
			assert.equal(
				logs.some((line) => line.includes("stage=google_stream_generate")),
				true,
			);
		},
	],
	[
		"streams Google upstream errors through generate handler",
		async () => {
			const resp = await mod.handleGoogleGenerate(
				{
					contents: [{ role: "user", parts: [{ text: "fail stream" }] }],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					current_input_file_name: "message.txt",
					current_tools_file_name: "tools.txt",
					cookie: "",
					log_requests: false,
				},
				fakeProvider({
					streamText() {
						throw streamError("handler upstream down", "handler_down");
					},
				}),
				"/v1beta/models/gemini-3.5-flash:streamGenerateContent",
				true,
			);
			assert.equal(resp.status, 200);
			const frames = collectSSEData([await resp.text()]);
			assert.equal(frames.length, 1);
			assert.equal(frames[0].error.code, "handler_down");
			assert.equal(frames[0].error.message, "handler upstream down");
			assert.equal(frames[0].modelVersion, "gemini-3.5-flash");
		},
	],
	[
		"streams Google tool calls through generate handler",
		async () => {
			const logs = [];
			let resp;
			let body = "";
			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					resp = await mod.handleGoogleGenerate(
						{
							contents: [{ role: "user", parts: [{ text: "read file" }] }],
							tools: [
								{
									functionDeclarations: [
										{ name: "Read", parameters: { type: "object" } },
									],
								},
							],
							toolConfig: { functionCallingConfig: { mode: "ANY" } },
						},
						{
							default_model: "gemini-3.5-flash",
							current_input_file_enabled: false,
							current_input_file_min_bytes: 1000000,
							current_input_file_name: "message.txt",
							current_tools_file_name: "tools.txt",
							cookie: "",
							log_requests: true,
						},
						fakeStreamProvider([
							'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
						]),
						"/v1beta/models/gemini-3.5-flash:streamGenerateContent",
						true,
					);
					body = await resp.text();
				},
			);
			assert.equal(resp.status, 200);
			assert.match(
				body,
				/"functionCall":\{"name":"Read","args":\{"path":"README.md"\}\}/,
			);
			assert.match(body, /"finishReason":"STOP"/);
			assert.equal(
				logs.some((line) => line.includes("stage=google_stream_generate")),
				true,
			);
			assert.equal(
				logs.some((line) => line.includes("tools=1")),
				true,
			);
		},
	],
	[
		"streams Google plain deltas and usage done payload",
		async () => {
			const writes = [];
			await mod.streamGooglePlain(
				(chunk) => writes.push(chunk),
				{ log_requests: false },
				{
					provider: fakeStreamProvider(["he", "llo"]),
					prompt: "say hello",
					rm: { name: "gemini-3.5-flash" },
					fileRefs: null,
					promptTokens: 3,
					signal: new AbortController().signal,
				},
			);
			const body = writes.join("");
			assert.match(body, /"text":"he"/);
			assert.match(body, /"text":"llo"/);
			assert.match(body, /"finishReason":"STOP"/);
			assert.match(body, /"promptTokenCount":3/);
		},
	],
	[
		"streams Google upstream error before any output",
		async () => {
			const writes = [];
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.streamGooglePlain(
						(chunk) => writes.push(chunk),
						baseConfig({ log_requests: true }),
						{
							provider: fakeProvider({
								streamText() {
									throw streamError("upstream down secret", "upstream_down");
								},
							}),
							prompt: "fail",
							rm: resolvedModel(),
							fileRefs: null,
							promptTokens: 2,
							signal: new AbortController().signal,
						},
					),
			);
			const frames = collectSSEData(writes);
			assert.equal(frames.length, 1);
			assert.equal(frames[0].error.code, "upstream_down");
			assert.equal(frames[0].error.message, "upstream down secret");
			assert.equal(frames[0].modelVersion, "gemini-3.5-flash");
			const failureLog = logs.find((line) =>
				line.includes("google stream failed before output"),
			);
			assert.match(failureLog, /error=type=Error code=upstream_down/);
			assert.doesNotMatch(failureLog, /upstream down secret/);
		},
	],
	[
		"streams Google warning and final done after partial output",
		async () => {
			const writes = [];
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.streamGooglePlain(
						(chunk) => writes.push(chunk),
						baseConfig({ log_requests: true }),
						{
							provider: fakeProvider({
								streamText() {
									return chunks(["partial"], 0);
								},
							}),
							prompt: "partial",
							rm: resolvedModel(),
							fileRefs: null,
							promptTokens: 4,
							signal: new AbortController().signal,
						},
					),
			);
			const frames = collectSSEData(writes);
			assert.equal(
				frames.some(
					(frame) =>
						frame.candidates &&
						frame.candidates[0].content.parts[0].text === "partial",
				),
				true,
			);
			assert.equal(
				frames.some(
					(frame) =>
						frame.warning && frame.warning.code === "stream_interrupted",
				),
				true,
			);
			assert.equal(
				frames.some(
					(frame) =>
						frame.promptFeedback &&
						frame.promptFeedback.warning.code === "stream_interrupted",
				),
				true,
			);
			assert.equal(frames[frames.length - 1].usageMetadata.promptTokenCount, 4);
			const warningLog = logs.find((line) =>
				line.includes("google stream interrupted after partial output"),
			);
			assert.match(warningLog, /error=type=Error/);
			assert.doesNotMatch(warningLog, /stream broke/);
		},
	],
	[
		"streams Google tool function calls and done usage",
		async () => {
			const writes = [];
			const tools = [
				{
					functionDeclarations: [
						{ name: "Read", parameters: { type: "object" } },
					],
				},
			];
			await mod.streamGoogleTools((chunk) => writes.push(chunk), baseConfig(), {
				provider: fakeStreamProvider([
					'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
				]),
				prompt: "read",
				rm: resolvedModel(),
				fileRefs: null,
				tools,
				effectiveReq: {
					tools,
					toolConfig: { functionCallingConfig: { mode: "ANY" } },
				},
				promptTokens: 5,
				signal: new AbortController().signal,
			});
			const frames = collectSSEData(writes);
			const callFrame = frames.find((frame) => frame.candidates?.[0].content);
			assert.equal(
				callFrame.candidates[0].content.parts[0].functionCall.name,
				"Read",
			);
			assert.equal(
				callFrame.candidates[0].content.parts[0].functionCall.args.path,
				"README.md",
			);
			assert.equal(frames[frames.length - 1].usageMetadata.promptTokenCount, 5);
			assert.equal(
				frames[frames.length - 1].candidates[0].finishReason,
				"STOP",
			);
		},
	],
	[
		"streams Google tool warning when stream interrupts after parsed call",
		async () => {
			const writes = [];
			const logs = [];
			const tools = [
				{
					functionDeclarations: [
						{ name: "Read", parameters: { type: "object" } },
					],
				},
			];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.streamGoogleTools(
						(chunk) => writes.push(chunk),
						baseConfig({ log_requests: true }),
						{
							provider: fakeProvider({
								streamText() {
									return chunks(
										[
											'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
										],
										0,
									);
								},
							}),
							prompt: "read",
							rm: resolvedModel(),
							fileRefs: null,
							tools,
							effectiveReq: {
								tools,
								toolConfig: { functionCallingConfig: { mode: "ANY" } },
							},
							promptTokens: 5,
							signal: new AbortController().signal,
						},
					),
			);
			const frames = collectSSEData(writes);
			assert.equal(
				frames.some(
					(frame) =>
						frame.warning && frame.warning.code === "stream_interrupted",
				),
				true,
			);
			const callFrame = frames.find((frame) => frame.candidates?.[0].content);
			assert.equal(
				callFrame.candidates[0].content.parts[0].functionCall.name,
				"Read",
			);
			assert.equal(frames[frames.length - 1].usageMetadata.promptTokenCount, 5);
			const warningLog = logs.find((line) =>
				line.includes("google tool stream interrupted after partial output"),
			);
			assert.match(warningLog, /error=type=Error/);
			assert.doesNotMatch(warningLog, /stream broke/);
		},
	],
	[
		"streams Google tool policy violations as error frames",
		async () => {
			const writes = [];
			const tools = [
				{
					functionDeclarations: [
						{ name: "Read", parameters: { type: "object" } },
					],
				},
			];
			await mod.streamGoogleTools((chunk) => writes.push(chunk), baseConfig(), {
				provider: fakeStreamProvider([
					'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
				]),
				prompt: "do not call tools",
				rm: resolvedModel(),
				fileRefs: null,
				tools,
				effectiveReq: {
					tools,
					toolConfig: { functionCallingConfig: { mode: "NONE" } },
				},
				promptTokens: 5,
				signal: new AbortController().signal,
			});
			const frames = collectSSEData(writes);
			assert.equal(frames.length, 1);
			assert.equal(frames[0].error.code, "tool_choice_violation");
			assert.match(
				frames[0].error.message,
				/does not allow function\(s\): Read/,
			);
			assert.equal(frames[0].modelVersion, "gemini-3.5-flash");
		},
	],
];
