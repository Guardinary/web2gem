import type { CompletionProvider, CompletionTextInput } from "./ports";

export type { StreamConsumeOptions } from "./stream-coalesce";
export type {
	BufferedToolTextStreamSummary,
	CompletionStreamEvent,
	CompletionStreamLifecycle,
	GeminiCompletionInput,
	PlainStreamSummary,
	ToolSieveStreamSummary,
} from "./stream-events";
export {
	createCompletionStreamLifecycle,
	consumeBufferedToolTextDeltas,
	consumePlainTextDeltas,
	consumeToolSieveTextDeltas,
	streamBufferedToolTextCompletionEvents,
	streamPlainCompletionEvents,
	streamToolSieveCompletionEvents,
	recordCompletionStreamEvent,
} from "./stream-events";

export async function runCompletionText(
	provider: CompletionProvider,
	input: CompletionTextInput,
) {
	return provider.generateText(input);
}
