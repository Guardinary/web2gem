import { firstNonEmptyString } from "../attachments/mime";
import { isRecord } from "../shared/types";
import type { UnknownRecord } from "../shared/types";

export type ToolMeta = {
	name: string;
	description: string;
	parameters: unknown;
};

export function extractToolMeta(tool: unknown): ToolMeta | null {
	if (!isRecord(tool)) return null;
	const fn = isRecord(tool.function) ? tool.function : null;
	const wrappedTool = isRecord(tool.tool) ? tool.tool : null;
	const name = firstNonEmptyString(tool.name, fn?.name, wrappedTool?.name);
	if (!name) return null;
	return {
		name,
		description: firstNonEmptyString(
			tool.description,
			fn?.description,
			wrappedTool?.description,
		),
		parameters: firstNonNil(
			tool.parameters,
			tool.input_schema,
			tool.inputSchema,
			tool.schema,
			tool.parametersJsonSchema,
			tool.parameters_json_schema,
			fn?.parameters,
			fn?.input_schema,
			fn?.inputSchema,
			fn?.schema,
			fn?.parametersJsonSchema,
			fn?.parameters_json_schema,
			wrappedTool?.parameters,
			wrappedTool?.input_schema,
			wrappedTool?.inputSchema,
			wrappedTool?.schema,
			wrappedTool?.parametersJsonSchema,
			wrappedTool?.parameters_json_schema,
		),
	};
}

export function toolMetasFromTools(tools: unknown): ToolMeta[] {
	const items = toolItemsFromTools(tools);
	if (!items.length) return [];
	const out: ToolMeta[] = [];
	for (const item of items) {
		const declarations = toolFunctionDeclarations(item);
		if (declarations.length) {
			for (const declaration of declarations) {
				const meta = extractToolMeta(declaration);
				if (meta) out.push(meta);
			}
			continue;
		}
		const meta = extractToolMeta(item);
		if (meta) out.push(meta);
	}
	return out;
}

export function toolDefsFromTools(tools: unknown): ToolMeta[] {
	return toolMetasFromTools(tools).map((meta) => ({
		name: meta.name,
		description: meta.description,
		parameters: meta.parameters || {},
	}));
}

export function normalizeToolsToOpenAIFunctionTools(
	tools: unknown,
): UnknownRecord[] | null {
	const items = toolItemsFromTools(tools);
	if (!items.length) return null;
	const out: UnknownRecord[] = [];
	for (const item of items) {
		const declarations = toolFunctionDeclarations(item);
		if (declarations.length) {
			for (const declaration of declarations) {
				const converted = openAIFunctionToolFromMeta(
					extractToolMeta(declaration),
				);
				if (converted) out.push(converted);
			}
			continue;
		}
		const converted = openAIFunctionToolFromMeta(extractToolMeta(item));
		if (converted) out.push(converted);
	}
	return out.length ? out : null;
}

export function toolItemsFromTools(tools: unknown): UnknownRecord[] {
	if (Array.isArray(tools)) return tools.filter(isRecord);
	if (!isRecord(tools)) return [];
	if (Array.isArray(tools.tools)) return tools.tools.filter(isRecord);
	if (toolFunctionDeclarations(tools).length) return [tools];
	if (tools.name || tools.function || tools.tool) return [tools];
	return [];
}

export function toolFunctionDeclarations(group: unknown): UnknownRecord[] {
	if (!isRecord(group)) return [];
	const declarations =
		group.functionDeclarations ||
		group.function_declarations ||
		group.functions ||
		[];
	return Array.isArray(declarations) ? declarations.filter(isRecord) : [];
}

export function firstNonNil(...values: unknown[]): unknown {
	for (const value of values) if (value != null) return value;
	return null;
}

function openAIFunctionToolFromMeta(
	meta: ToolMeta | null,
): UnknownRecord | null {
	if (!meta?.name) return null;
	const fn: UnknownRecord = { name: meta.name };
	if (meta.description) fn.description = meta.description;
	if (meta.parameters != null) fn.parameters = meta.parameters;
	return { type: "function", function: fn };
}
