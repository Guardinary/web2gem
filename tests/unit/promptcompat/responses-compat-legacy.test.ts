import { test } from "vitest";
import { normalizeResponsesInputAsMessages } from "../../../src/promptcompat/responses-input";
import { assert } from "../assertions.js";

test("keeps legacy scalar fallback ordering around pending reasoning", () => {
	const messages = normalizeResponsesInputAsMessages({
		input: [
			{ type: "reasoning", text: "pending" },
			42,
			{
				type: "function_call",
				call_id: "call_1",
				name: "Lookup",
				arguments: { id: 1 },
			},
		],
	});

	assert.deepEqual(messages[0], { role: "user", content: "42" });
	assert.equal(messages[1]?.role, "assistant");
	assert.equal(messages[1]?.reasoning_content, "pending");
	assert.equal(messages[1]?.tool_calls[0]?.function.name, "Lookup");
});
