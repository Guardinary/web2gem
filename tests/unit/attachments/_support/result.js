export function attachmentResult(overrides = {}) {
	return {
		fileRefs: overrides.fileRefs ?? null,
		imageFileRefs: overrides.imageFileRefs ?? null,
		genericFileRefs: overrides.genericFileRefs ?? null,
		promptText: overrides.promptText || "",
		droppedNote: overrides.droppedNote || "",
		supportsFileRefs: overrides.supportsFileRefs ?? true,
		usage: overrides.usage || {
			uploadedFiles: overrides.fileRefs ? overrides.fileRefs.length : 0,
			dedupedFiles: 0,
			uploadedBytes: 0,
			fileRefBytes: 0,
			inlinedFiles: overrides.promptText ? 1 : 0,
			inlinedBytes: 0,
			droppedFiles: overrides.droppedNote ? 1 : 0,
			multipartUploads: 0,
		},
	};
}
