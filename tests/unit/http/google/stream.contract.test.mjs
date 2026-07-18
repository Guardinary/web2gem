import { describe, test } from "vitest";
import { handleGoogleGenerate } from "../../../../src/http/google/handlers";
import { parseGoogleGenerationPath } from "../../../../src/http/google/model-path";
import {
	streamGooglePlain,
	streamGoogleTools,
} from "../../../../src/http/google/stream";
import { parseGoogleToolChoicePolicy } from "../../../../src/toolcall/policy-google";
import { createToolBundle } from "../../../../src/toolcall/tool-bundle";
import { assert } from "../../assertions.js";
import { chunks } from "../../_support/async-stream.js";
import { withConsoleLog } from "../../_support/globals.js";
import { baseConfig } from "../../_support/runtime-config.js";
import { resolvedModel, streamError } from "../_support/provider.js";
import { collectSSEData } from "../_support/sse.js";
import { streamProvider, strictProvider } from "../_support/provider.js";

describe("Google streaming", () => {
	test("streams Google tool text warnings through generate handler", async () => {
		const resp = await handleGoogleGenerate(
			{
				contents: [{ role: "user", parts: [{ text: "read a file" }] }],
				tools: [
					{
						functionDeclarations: [
							{ name: "Read", parameters: { type: "object" } },
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
			strictProvider({
				streamText() {
					return chunks(["partial answer"], 0);
				},
			}),
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:streamGenerateContent",
			),
			true,
		);
		assert.equal(resp.status, 200);
		const events = collectSSEData([await resp.text()]);
		assert.equal(
			events.some(
				(event) =>
					event.candidates?.[0]?.content?.parts?.[0]?.text === "partial answer",
			),
			true,
		);
		const warning = events.find((event) => event.warning);
		assert.equal(warning.warning.code, "stream_interrupted");
		assert.equal(
			events.some(
				(event) =>
					event.candidates &&
					String(event.candidates[0].content?.parts?.[0]?.text || "").includes(
						"stream interrupted after partial output",
					),
			),
			false,
		);
		assert.equal(events.at(-1).usageMetadata.totalTokenCount >= 0, true);
	});
	test("streams safe Google tool-compatible plain deltas before done", async () => {
		const text = "x".repeat(80);
		const resp = await handleGoogleGenerate(
			{
				contents: [{ role: "user", parts: [{ text: "summarize" }] }],
				tools: [
					{
						functionDeclarations: [
							{ name: "Read", parameters: { type: "object" } },
						],
					},
				],
			},
			baseConfig(),
			streamProvider([text]),
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:streamGenerateContent",
			),
			true,
		);
		assert.equal(resp.status, 200);
		const events = collectSSEData([await resp.text()]);
		assert.equal(
			events
				.flatMap((event) => event.candidates?.[0]?.content?.parts || [])
				.map((part) => part.text || "")
				.join(""),
			text,
		);
		const done = events.at(-1);
		assert.equal(
			done.usageMetadata.totalTokenCount,
			done.usageMetadata.promptTokenCount +
				done.usageMetadata.candidatesTokenCount,
		);
	});
	test("streams Google upstream_empty for an empty tool-compatible stream", async () => {
		const resp = await handleGoogleGenerate(
			{
				contents: [{ role: "user", parts: [{ text: "read" }] }],
				tools: [
					{
						functionDeclarations: [
							{ name: "Read", parameters: { type: "object" } },
						],
					},
				],
			},
			baseConfig(),
			streamProvider([]),
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:streamGenerateContent",
			),
			true,
		);
		assert.equal(resp.status, 200);
		const events = collectSSEData([await resp.text()]);
		assert.equal(events.length, 1);
		assert.equal(events[0].error.code, "upstream_empty");
		assert.equal(events[0].modelVersion, "gemini-3.5-flash");
	});
	test("streams Google plain responses through generate handler", async () => {
		const logs = [];
		let resp;
		let body = "";
		await withConsoleLog(
			(line) => logs.push(String(line)),
			async () => {
				resp = await handleGoogleGenerate(
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
					streamProvider(["he", "llo"]),
					parseGoogleGenerationPath(
						"/v1beta/models/gemini-3.5-flash:streamGenerateContent",
					),
					true,
				);
				body = await resp.text();
			},
		);
		assert.equal(resp.status, 200);
		assert.match(body, /"text":"he"/);
		assert.match(body, /"text":"llo"/);
		assert.match(body, /"finishReason":"STOP"/);
		const done = collectSSEData([body]).at(-1);
		assert.equal(done.usageMetadata.promptTokenCount >= 0, true);
		assert.equal(done.usageMetadata.candidatesTokenCount >= 0, true);
		assert.equal(
			done.usageMetadata.totalTokenCount,
			done.usageMetadata.promptTokenCount +
				done.usageMetadata.candidatesTokenCount,
		);
		assert.equal(
			logs.some((line) => line.includes("stage=google_prepare")),
			true,
		);
		assert.equal(
			logs.some((line) => line.includes("stage=google_stream_generate")),
			true,
		);
	});
	test("streams Google upstream errors through generate handler", async () => {
		const resp = await handleGoogleGenerate(
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
			strictProvider({
				streamText() {
					throw streamError("handler upstream down", "handler_down");
				},
			}),
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:streamGenerateContent",
			),
			true,
		);
		assert.equal(resp.status, 200);
		const frames = collectSSEData([await resp.text()]);
		assert.equal(frames.length, 1);
		assert.equal(frames[0].error.code, "handler_down");
		assert.equal(frames[0].error.message, "handler upstream down");
		assert.equal(frames[0].modelVersion, "gemini-3.5-flash");
	});
	test("streams Google tool upstream errors through generate handler", async () => {
		const resp = await handleGoogleGenerate(
			{
				contents: [{ role: "user", parts: [{ text: "fail tool stream" }] }],
				tools: [
					{
						functionDeclarations: [
							{ name: "Read", parameters: { type: "object" } },
						],
					},
				],
			},
			baseConfig(),
			strictProvider({
				streamText() {
					throw streamError("tool handler upstream down", "tool_handler_down");
				},
			}),
			parseGoogleGenerationPath(
				"/v1beta/models/gemini-3.5-flash:streamGenerateContent",
			),
			true,
		);
		assert.equal(resp.status, 200);
		const frames = collectSSEData([await resp.text()]);
		assert.equal(frames.length, 1);
		assert.equal(frames[0].error.code, "tool_handler_down");
		assert.equal(frames[0].error.message, "tool handler upstream down");
		assert.equal(frames[0].modelVersion, "gemini-3.5-flash");
	});
	test("streams Google tool calls through generate handler", async () => {
		const logs = [];
		let resp;
		let body = "";
		await withConsoleLog(
			(line) => logs.push(String(line)),
			async () => {
				resp = await handleGoogleGenerate(
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
					streamProvider([
						'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
					]),
					parseGoogleGenerationPath(
						"/v1beta/models/gemini-3.5-flash:streamGenerateContent",
					),
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
		const done = collectSSEData([body]).at(-1);
		assert.equal(done.usageMetadata.promptTokenCount >= 0, true);
		assert.equal(done.usageMetadata.candidatesTokenCount >= 0, true);
		assert.equal(
			done.usageMetadata.totalTokenCount,
			done.usageMetadata.promptTokenCount +
				done.usageMetadata.candidatesTokenCount,
		);
		assert.equal(
			logs.some((line) => line.includes("stage=google_stream_generate")),
			true,
		);
		assert.equal(
			logs.some((line) => line.includes("tools=1")),
			true,
		);
	});
	test("streams Google warning and final done after partial output", async () => {
		const writes = [];
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			() =>
				streamGooglePlain(
					(chunk) => writes.push(chunk),
					baseConfig({ log_requests: true }),
					{
						provider: strictProvider({
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
				(frame) => frame.warning && frame.warning.code === "stream_interrupted",
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
	});
	test("streams Google tool warning when stream interrupts after parsed call", async () => {
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
				streamGoogleTools(
					(chunk) => writes.push(chunk),
					baseConfig({ log_requests: true }),
					{
						provider: strictProvider({
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
						tools: createToolBundle(tools),
						toolPolicy: parseGoogleToolChoicePolicy(
							{
								tools,
								toolConfig: { functionCallingConfig: { mode: "ANY" } },
							},
							createToolBundle(tools),
						),
						promptTokens: 5,
						signal: new AbortController().signal,
					},
				),
		);
		const frames = collectSSEData(writes);
		assert.equal(
			frames.some(
				(frame) => frame.warning && frame.warning.code === "stream_interrupted",
			),
			true,
		);
		const callFrame = frames.find((frame) => frame.candidates?.[0].content);
		const warningIndex = frames.findIndex((frame) => frame.warning);
		const callIndex = frames.findIndex(
			(frame) => frame.candidates?.[0].content,
		);
		assert.equal(warningIndex >= 0, true);
		assert.equal(warningIndex < callIndex, true);
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
	});
	test("streams Google tool policy violations as error frames", async () => {
		const writes = [];
		const tools = [
			{
				functionDeclarations: [
					{ name: "Read", parameters: { type: "object" } },
				],
			},
		];
		await streamGoogleTools((chunk) => writes.push(chunk), baseConfig(), {
			provider: streamProvider([
				'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
			]),
			prompt: "do not call tools",
			rm: resolvedModel(),
			fileRefs: null,
			tools: createToolBundle(tools),
			toolPolicy: parseGoogleToolChoicePolicy(
				{
					tools,
					toolConfig: { functionCallingConfig: { mode: "NONE" } },
				},
				createToolBundle(tools),
			),
			promptTokens: 5,
			signal: new AbortController().signal,
		});
		const frames = collectSSEData(writes);
		assert.equal(frames.length, 1);
		assert.equal(frames[0].error.code, "tool_choice_violation");
		assert.match(frames[0].error.message, /does not allow function\(s\): Read/);
		assert.equal(frames[0].modelVersion, "gemini-3.5-flash");
	});
});
