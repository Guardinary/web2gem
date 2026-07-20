import type { AttachmentPlan } from "../../../../src/attachments/types";
import type { CompletionProvider } from "../../../../src/completion/ports";
import { type ResolvedModelOk, resolveModel } from "../../../../src/models";
import type { ErrorWithMetadata } from "../../../../src/shared/types";
import { attachmentResult } from "../../attachments/_support/result.js";

function unexpected(method: string): (...args: unknown[]) => never {
	return () => {
		throw new Error(`unexpected provider.${method} call`);
	};
}

function emptyOrExistingAttachmentResult(plan: AttachmentPlan) {
	if (plan.candidates.length > 0 || plan.dropped.length > 0)
		throw new Error(
			`unexpected local attachment plan candidates=${plan.candidates.length} drops=${plan.dropped.length}`,
		);
	const fileRefs = plan.existingFileRefs?.length ? plan.existingFileRefs : null;
	return attachmentResult({ fileRefs });
}

export function strictProvider(
	overrides: Partial<CompletionProvider> = {},
): CompletionProvider {
	const provider: CompletionProvider = {
		supportsAuthenticatedSession: true,
		generateText: unexpected("generateText"),
		streamText: unexpected("streamText"),
		async resolveAttachments(plan) {
			return emptyOrExistingAttachmentResult(plan);
		},
		uploadTextFile: unexpected("uploadTextFile"),
	};
	return { ...provider, ...overrides };
}

export function noWorkProvider(
	overrides: Partial<CompletionProvider> = {},
): CompletionProvider {
	return strictProvider({
		generateText: unexpected("generateText"),
		generateRich: unexpected("generateRich"),
		streamText: unexpected("streamText"),
		resolveAttachments: unexpected("resolveAttachments"),
		uploadTextFile: unexpected("uploadTextFile"),
		...overrides,
	});
}

export function streamProvider(
	items: Iterable<string>,
	overrides: Partial<CompletionProvider> = {},
): CompletionProvider {
	return strictProvider({
		streamText() {
			return (async function* generateDeltas() {
				for (const item of items) yield item;
			})();
		},
		async resolveAttachments(plan) {
			return emptyOrExistingAttachmentResult(plan);
		},
		...overrides,
	});
}

export function resolvedModel(name = "gemini-3.5-flash"): ResolvedModelOk {
	const resolved = resolveModel(name, name);
	if ("error" in resolved) throw new Error(resolved.error);
	return resolved;
}

export function streamError(
	message = "stream broke",
	code = "stream_broke",
): ErrorWithMetadata {
	const error: ErrorWithMetadata = new Error(message);
	error.code = code;
	return error;
}
