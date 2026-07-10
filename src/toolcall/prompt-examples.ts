import {
	indentPromptParameters,
	promptCDATA,
	wrapParameter,
	xmlEscapeAttr,
} from "./prompt-xml";

type ToolExample = { name: string; params: string };

export function buildReadToolCacheGuard(toolNames: unknown): string {
	if (!hasReadLikeTool(toolNames)) return "";
	return "\nRead-tool cache guard: If a Read/read_file-style tool result says the file is unchanged, already available in history, should be referenced from previous context, or otherwise provides no file body, treat that result as missing content. Do not repeatedly call the same read request for that missing body. Request a full-content read if the tool supports it, or tell the user that the file contents need to be provided again.\n\n";
}

export function hasReadLikeTool(toolNames: unknown): boolean {
	for (const name of asArray(toolNames)) {
		const normalized = String(name || "")
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "");
		if (normalized === "read" || normalized === "readfile") return true;
	}
	return false;
}

export function buildCorrectToolExamples(toolNames: unknown): string {
	const names = uniqueToolNames(toolNames);
	const examples: string[] = [];
	const single = firstBasicExample(names);
	if (single)
		examples.push(
			`Example A - Single tool:\n${renderToolExampleBlock([single])}`,
		);
	const parallel = firstNBasicExamples(names, 2);
	if (parallel.length >= 2)
		examples.push(
			`Example B - Two tools in parallel:\n${renderToolExampleBlock(parallel)}`,
		);
	const nested = firstNestedExample(names);
	if (nested)
		examples.push(
			`Example C - Tool with nested XML parameters:\n${renderToolExampleBlock([nested])}`,
		);
	const script = firstScriptExample(names);
	if (script)
		examples.push(
			`Example D - Tool with long script using CDATA (RELIABLE FOR CODE/SCRIPTS):\n${renderToolExampleBlock([script])}`,
		);
	return examples.length
		? `CORRECT EXAMPLES:\n\n${examples.join("\n\n")}\n\n`
		: "";
}

export function uniqueToolNames(toolNames: unknown): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const raw of asArray(toolNames)) {
		const name = String(raw || "").trim();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	return names;
}

export function firstBasicExample(
	names: readonly string[],
): ToolExample | null {
	for (const name of names) {
		const params = exampleBasicParams(name);
		if (params != null) return { name, params };
	}
	return null;
}

export function firstNBasicExamples(
	names: readonly string[],
	count: number,
): ToolExample[] {
	const out: ToolExample[] = [];
	for (const name of names) {
		const params = exampleBasicParams(name);
		if (params == null) continue;
		out.push({ name, params });
		if (out.length === count) return out;
	}
	return out;
}

export function firstNestedExample(
	names: readonly string[],
): ToolExample | null {
	for (const name of names) {
		const params = exampleNestedParams(name);
		if (params != null) return { name, params };
	}
	return null;
}

export function firstScriptExample(
	names: readonly string[],
): ToolExample | null {
	for (const name of names) {
		const params = exampleScriptParams(name);
		if (params != null) return { name, params };
	}
	return null;
}

export function renderToolExampleBlock(calls: readonly ToolExample[]): string {
	let out = "<|DSML|tool_calls>\n";
	for (const call of calls) {
		out += `  <|DSML|invoke name="${xmlEscapeAttr(call.name)}">\n`;
		out += `${indentPromptParameters(call.params, "    ")}\n`;
		out += "  </|DSML|invoke>\n";
	}
	return `${out}</|DSML|tool_calls>`;
}

export function exampleBasicParams(name: unknown): string | null {
	switch (String(name || "").trim()) {
		case "Read":
			return wrapParameter("file_path", promptCDATA("README.md"));
		case "Glob":
			return `${wrapParameter("pattern", promptCDATA("**/*.go"))}\n${wrapParameter("path", promptCDATA("."))}`;
		case "read_file":
			return wrapParameter("path", promptCDATA("src/main.go"));
		case "list_files":
			return wrapParameter("path", promptCDATA("."));
		case "search_files":
			return wrapParameter("query", promptCDATA("tool call parser"));
		case "Bash":
		case "execute_command":
			return wrapParameter("command", promptCDATA("pwd"));
		case "exec_command":
			return wrapParameter("cmd", promptCDATA("pwd"));
		case "Write":
			return `${wrapParameter("file_path", promptCDATA("notes.txt"))}\n${wrapParameter("content", promptCDATA("Hello world"))}`;
		case "write_to_file":
			return `${wrapParameter("path", promptCDATA("notes.txt"))}\n${wrapParameter("content", promptCDATA("Hello world"))}`;
		case "Edit":
			return `${wrapParameter("file_path", promptCDATA("README.md"))}\n${wrapParameter("old_string", promptCDATA("foo"))}\n${wrapParameter("new_string", promptCDATA("bar"))}`;
		case "MultiEdit":
			return `${wrapParameter("file_path", promptCDATA("README.md"))}\n<|DSML|parameter name="edits"><item><old_string>${promptCDATA("foo")}</old_string><new_string>${promptCDATA("bar")}</new_string></item></|DSML|parameter>`;
	}
	return null;
}

export function exampleNestedParams(name: unknown): string | null {
	switch (String(name || "").trim()) {
		case "MultiEdit":
			return `${wrapParameter("file_path", promptCDATA("README.md"))}\n<|DSML|parameter name="edits"><item><old_string>${promptCDATA("foo")}</old_string><new_string>${promptCDATA("bar")}</new_string></item></|DSML|parameter>`;
		case "Task":
			return `${wrapParameter("description", promptCDATA("Investigate flaky tests"))}\n${wrapParameter("prompt", promptCDATA("Run targeted tests and summarize failures"))}`;
		case "ask_followup_question":
			return `${wrapParameter("question", promptCDATA("Which approach do you prefer?"))}\n<|DSML|parameter name="follow_up"><item><text>${promptCDATA("Option A")}</text></item><item><text>${promptCDATA("Option B")}</text></item></|DSML|parameter>`;
	}
	return null;
}

export function exampleScriptParams(name: unknown): string | null {
	const scriptCommand =
		"cat > /tmp/test_escape.sh <<'EOF'\n#!/bin/bash\necho 'single \"double\"'\necho \"literal dollar: \\$HOME\"\nEOF\nbash /tmp/test_escape.sh";
	const scriptContent =
		'#!/bin/bash\necho \'single "double"\'\necho "literal dollar: $HOME"';
	switch (String(name || "").trim()) {
		case "Bash":
			return `${wrapParameter("command", promptCDATA(scriptCommand))}\n${wrapParameter("description", promptCDATA("Test shell escaping"))}`;
		case "execute_command":
			return wrapParameter("command", promptCDATA(scriptCommand));
		case "exec_command":
			return wrapParameter("cmd", promptCDATA(scriptCommand));
		case "Write":
			return `${wrapParameter("file_path", promptCDATA("test_escape.sh"))}\n${wrapParameter("content", promptCDATA(scriptContent))}`;
		case "write_to_file":
			return `${wrapParameter("path", promptCDATA("test_escape.sh"))}\n${wrapParameter("content", promptCDATA(scriptContent))}`;
	}
	return null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
