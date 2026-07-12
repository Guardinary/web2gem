const DOC_ONLY_ROOT_FILES = new Set(["LICENSE", "README.md", "README.zh.md"]);

export function classifyChangedFiles(files) {
	const normalized = files
		.map((file) =>
			String(file || "")
				.replaceAll("\\", "/")
				.trim(),
		)
		.filter(Boolean);
	if (!normalized.length) return "runtime";
	return normalized.every(isDocumentationOnlyPath) ? "docs" : "runtime";
}

function isDocumentationOnlyPath(path) {
	if (DOC_ONLY_ROOT_FILES.has(path)) return true;
	return path.startsWith("docs/");
}
