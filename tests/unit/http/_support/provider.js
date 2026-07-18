import { attachmentResult } from "../../helpers.js";

function unexpected(method) {
	return () => {
		throw new Error(`unexpected provider.${method} call`);
	};
}

function emptyOrExistingAttachmentResult(plan) {
	if (plan.candidates.length > 0 || plan.dropped.length > 0)
		throw new Error(
			`unexpected local attachment plan candidates=${plan.candidates.length} drops=${plan.dropped.length}`,
		);
	const fileRefs = plan.existingFileRefs?.length ? plan.existingFileRefs : null;
	return attachmentResult({ fileRefs });
}

export function strictProvider(overrides = {}) {
	const provider = {
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

export function noWorkProvider(overrides = {}) {
	return strictProvider({
		generateText: unexpected("generateText"),
		generateRich: unexpected("generateRich"),
		streamText: unexpected("streamText"),
		resolveAttachments: unexpected("resolveAttachments"),
		uploadTextFile: unexpected("uploadTextFile"),
		...overrides,
	});
}

export function streamProvider(items, overrides = {}) {
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
