import { firstNonEmptyString } from "../shared/strings";
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
