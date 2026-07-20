import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { errorLine, outputLine } from "../server/io.mjs";

const scanRoot = resolve(process.cwd(), process.argv[2] || "tests/unit");
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const directivePattern = /@ts-(?:nocheck|ignore|expect-error)\b/g;

try {
	const files = await collectTypeScriptFiles(scanRoot);
	const violations = [];
	for (const file of files) {
		const source = await readFile(file, "utf8");
		const lines = source.split(/\r?\n/);
		for (let index = 0; index < lines.length; index++) {
			for (const match of lines[index].matchAll(directivePattern)) {
				violations.push({
					file: displayPath(file),
					line: index + 1,
					directive: match[0],
				});
			}
		}
	}

	if (violations.length > 0) {
		errorLine("TypeScript test type suppression check failed:");
		for (const violation of violations) {
			errorLine(
				`- ${violation.file}:${violation.line}: ${violation.directive}`,
			);
		}
		process.exit(1);
	}

	outputLine(
		`TypeScript test type suppression check passed: ${files.length} files scanned`,
	);
} catch (error) {
	errorLine("TypeScript test type suppression check failed:", error);
	process.exit(1);
}

async function collectTypeScriptFiles(root) {
	const files = [];
	await visit(root, files);
	return files.sort((left, right) => {
		const leftPath = displayPath(left);
		const rightPath = displayPath(right);
		return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
	});
}

async function visit(directory, files) {
	const entries = await readdir(directory, { withFileTypes: true });
	entries.sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			await visit(path, files);
		} else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
			files.push(path);
		}
	}
}

function displayPath(file) {
	return relative(process.cwd(), file).replaceAll("\\", "/");
}
