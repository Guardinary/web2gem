export type { StreamConsumeOptions } from "./stream-coalesce";
export type {
	CompletionStreamEvent,
	CompletionStreamLifecycle,
	GeminiCompletionInput,
} from "./stream-events";
export {
	createCompletionStreamLifecycle,
	streamBufferedToolTextCompletionEvents,
	streamPlainCompletionEvents,
	streamToolSieveCompletionEvents,
	recordCompletionStreamEvent,
} from "./stream-events";
