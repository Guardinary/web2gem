import { describe, test } from "vitest";
import {
	reduceResponsesSequence,
	responsesItemKind,
	responsesItemRole,
	type ResponsesSequenceEvent,
} from "../../../src/promptcompat/responses-semantics";
import { assert } from "../assertions.js";

type ProjectedItem = {
	role: string;
	reasoning: string;
	toolCalls: string[];
	text: string;
};

describe("Responses shared semantics", () => {
	test("owns item recognition and role normalization", () => {
		const cases = [
			[{ role: "developer", content: "rules" }, "role-message", "system"],
			[{ role: "function", content: "done" }, "role-message", "tool"],
			[{ type: "input_message" }, "message", "user"],
			[{ type: "tool_result" }, "tool-result", "user"],
			[{ type: "function_call" }, "tool-call", "user"],
			[{ type: "thinking" }, "reasoning", "user"],
			[{ type: "input_image" }, "input-image", "user"],
			[{ type: "input_file" }, "file", "user"],
			[{ type: "summary_text" }, "text", "user"],
			[{ type: "custom_event" }, "unknown", "user"],
		] as const;
		for (const [item, kind, role] of cases) {
			assert.equal(responsesItemKind(item), kind);
			assert.equal(responsesItemRole(item), role);
		}
	});

	test("groups reasoning, adjacent tool calls, and fallback text in one reducer", () => {
		const events: ResponsesSequenceEvent<ProjectedItem>[] = [
			{ kind: "reasoning", text: "first thought" },
			{ kind: "reasoning", text: "second thought" },
			{
				kind: "message",
				value: {
					role: "assistant",
					reasoning: "",
					toolCalls: ["Lookup"],
					text: "",
				},
			},
			{
				kind: "message",
				value: {
					role: "assistant",
					reasoning: "",
					toolCalls: ["Read"],
					text: "",
				},
			},
			{
				kind: "message",
				value: {
					role: "tool",
					reasoning: "",
					toolCalls: [],
					text: "done",
				},
			},
			{ kind: "fallback", text: "follow" },
			{ kind: "fallback", text: "up" },
		];

		const projected = reduceResponsesSequence(events, {
			createReasoning: (reasoning) => ({
				role: "assistant",
				reasoning,
				toolCalls: [],
				text: "",
			}),
			createFallback: (text) => ({
				role: "user",
				reasoning: "",
				toolCalls: [],
				text,
			}),
			isToolCall: (item) => item.toolCalls.length > 0,
			reasoningText: (item) => item.reasoning,
			attachReasoning: (item, reasoning) => {
				item.reasoning = reasoning;
			},
			mergeToolCalls: (previous, next) => {
				previous.toolCalls.push(...next.toolCalls);
				return true;
			},
		});

		assert.deepEqual(projected, [
			{
				role: "assistant",
				reasoning: "first thought\nsecond thought",
				toolCalls: ["Lookup", "Read"],
				text: "",
			},
			{ role: "tool", reasoning: "", toolCalls: [], text: "done" },
			{ role: "user", reasoning: "", toolCalls: [], text: "follow\nup" },
		]);
	});
});
