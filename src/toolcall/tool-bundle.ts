import { isRecord } from "../shared/types";
import type { UnknownRecord } from "../shared/types";
import {
	GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT,
	buildToolCallInstructions,
	buildToolPromptBlock,
} from "./prompt-format";
import {
	extractToolMeta,
	toolFunctionDeclarations,
	toolItemsFromTools,
} from "./tool-meta";
import type { ToolMeta } from "./tool-meta";

type NameSet = Record<string, boolean>;
type BundlePolicy = {
	mode?: unknown;
	allowed?: NameSet | null;
	hasAllowed?: boolean;
};
type ToolPromptDef = {
	name?: unknown;
	description?: unknown;
	parameters?: unknown;
};

export type ToolSchemaIndex = Record<string, UnknownRecord>;
export type ToolPromptArtifact = {
	readonly defs: readonly ToolPromptDef[];
	readonly names: readonly string[];
	toolCallInstructions: () => string;
	inlinePromptBlock: (toolChoiceInstruction?: unknown) => string;
	contextTranscript: (
		toolChoiceInstruction?: unknown,
		filename?: unknown,
	) => string;
};

export type ToolBundle = {
	readonly __toolBundle: true;
	readonly source: unknown;
	readonly items: UnknownRecord[];
	readonly metas: ToolMeta[];
	readonly defs: ToolMeta[];
	readonly names: string[];
	readonly nameSet: NameSet;
	readonly openAIFunctionTools: UnknownRecord[];
	readonly schemaIndex: ToolSchemaIndex | null;
	readonly promptArtifact: ToolPromptArtifact;
};

export const emptyToolBundle: ToolBundle = {
	__toolBundle: true,
	source: null,
	items: [],
	metas: [],
	defs: [],
	names: [],
	nameSet: {},
	openAIFunctionTools: [],
	schemaIndex: null,
	promptArtifact: createToolPromptArtifact([], []),
};

export function isToolBundle(value: unknown): value is ToolBundle {
	return !!(
		value &&
		typeof value === "object" &&
		(value as { __toolBundle?: unknown }).__toolBundle === true
	);
}

export function createToolBundle(tools: unknown): ToolBundle {
	if (isToolBundle(tools)) return tools;
	const items = toolItemsFromTools(tools);
	if (!items.length) return emptyToolBundle;

	const metas: ToolMeta[] = [];
	const defs: ToolMeta[] = [];
	const names: string[] = [];
	const nameSet: NameSet = {};
	const openAIFunctionTools: UnknownRecord[] = [];
	const schemaIndex: ToolSchemaIndex = {};

	const addMeta = (meta: ToolMeta | null) => {
		if (!meta?.name) return;
		metas.push(meta);
		defs.push({
			name: meta.name,
			description: meta.description,
			parameters: meta.parameters || {},
		});
		if (!nameSet[meta.name]) {
			nameSet[meta.name] = true;
			names.push(meta.name);
		}
		const fn: UnknownRecord = { name: meta.name };
		if (meta.description) fn.description = meta.description;
		if (meta.parameters != null) fn.parameters = meta.parameters;
		openAIFunctionTools.push({ type: "function", function: fn });
		if (isRecord(meta.parameters))
			schemaIndex[meta.name.toLowerCase()] = meta.parameters;
	};

	for (const item of items) {
		const declarations = toolFunctionDeclarations(item);
		if (declarations.length) {
			for (const declaration of declarations)
				addMeta(extractToolMeta(declaration));
		} else {
			addMeta(extractToolMeta(item));
		}
	}

	if (!metas.length) return { ...emptyToolBundle, source: tools, items };
	return {
		__toolBundle: true,
		source: tools,
		items,
		metas,
		defs,
		names,
		nameSet,
		openAIFunctionTools,
		schemaIndex: Object.keys(schemaIndex).length ? schemaIndex : null,
		promptArtifact: createToolPromptArtifact(defs, names),
	};
}

export function filterToolBundleByPolicy(
	bundle: ToolBundle,
	policy: BundlePolicy | null | undefined,
): ToolBundle {
	if (
		!bundle.openAIFunctionTools.length ||
		(policy && policy.mode === "none")
	) {
		return { ...emptyToolBundle, source: bundle.source };
	}
	if (
		!policy?.allowed ||
		(!policy.hasAllowed && Object.keys(policy.allowed).length === 0)
	)
		return bundle;
	const metas: ToolMeta[] = [];
	const defs: ToolMeta[] = [];
	const names: string[] = [];
	const nameSet: NameSet = {};
	const openAIFunctionTools: UnknownRecord[] = [];
	const schemaIndex: ToolSchemaIndex = {};

	for (let i = 0; i < bundle.metas.length; i++) {
		const meta = bundle.metas[i];
		if (!meta || !policy.allowed[String(meta.name || "").trim()]) continue;
		metas.push(meta);
		const def = bundle.defs[i] || {
			name: meta.name,
			description: meta.description,
			parameters: meta.parameters || {},
		};
		defs.push(def);
		if (!nameSet[meta.name]) {
			nameSet[meta.name] = true;
			names.push(meta.name);
		}
		const tool = bundle.openAIFunctionTools[i];
		if (tool) openAIFunctionTools.push(tool);
		if (isRecord(meta.parameters))
			schemaIndex[meta.name.toLowerCase()] = meta.parameters;
	}

	if (!metas.length) return { ...emptyToolBundle, source: bundle.source };
	return {
		__toolBundle: true,
		source: bundle.source,
		items: bundle.items,
		metas,
		defs,
		names,
		nameSet,
		openAIFunctionTools,
		schemaIndex: Object.keys(schemaIndex).length ? schemaIndex : null,
		promptArtifact: createToolPromptArtifact(defs, names),
	};
}

export function nullableOpenAIFunctionTools(
	bundle: ToolBundle | null | undefined,
): UnknownRecord[] | null {
	return bundle?.openAIFunctionTools.length ? bundle.openAIFunctionTools : null;
}

export function toolNamesForPromptSource(
	source: unknown,
	fallbackDefs?: readonly ToolPromptDef[] | null,
): string[] {
	if (isToolBundle(source)) return source.names;
	const defs = toolPromptDefsFromSource(source, fallbackDefs);
	const names: string[] = [];
	const seen: NameSet = {};
	for (const def of defs) {
		const name = String(def?.name || "").trim();
		if (!name || seen[name]) continue;
		seen[name] = true;
		names.push(name);
	}
	return names;
}

export function toolCallInstructionsFor(
	source: unknown,
	fallbackDefs?: readonly ToolPromptDef[] | null,
): string {
	if (isToolBundle(source)) return source.promptArtifact.toolCallInstructions();
	return buildToolCallInstructions(
		toolNamesForPromptSource(source, fallbackDefs),
	);
}

export function toolPromptBlockFor(
	source: unknown,
	toolChoiceInstruction?: unknown,
	fallbackDefs?: readonly ToolPromptDef[] | null,
): string {
	if (isToolBundle(source))
		return source.promptArtifact.inlinePromptBlock(toolChoiceInstruction);
	const defs = toolPromptDefsFromSource(source, fallbackDefs);
	return defs.length
		? buildToolPromptBlock([...defs], toolChoiceInstruction)
		: "";
}

export function toolsContextTranscriptFor(
	source: unknown,
	toolChoiceInstruction?: unknown,
	filename: unknown = "tools.txt",
	fallbackDefs?: readonly ToolPromptDef[] | null,
): string {
	if (isToolBundle(source))
		return source.promptArtifact.contextTranscript(
			toolChoiceInstruction,
			filename,
		);
	const defs = toolPromptDefsFromSource(source, fallbackDefs);
	return buildToolsContextTranscriptFromDefs(
		defs,
		toolChoiceInstruction,
		filename,
	);
}

function toolPromptDefsFromSource(
	source: unknown,
	fallbackDefs?: readonly ToolPromptDef[] | null,
): readonly ToolPromptDef[] {
	if (Array.isArray(fallbackDefs)) return fallbackDefs;
	return Array.isArray(source) ? (source as ToolPromptDef[]) : [];
}

function createToolPromptArtifact(
	defs: readonly ToolMeta[],
	names: readonly string[],
): ToolPromptArtifact {
	const cachedDefs = defs.map((def) => ({
		name: def.name,
		description: def.description,
		parameters: def.parameters || {},
	}));
	const cachedNames = [...names];
	let instructions: string | null = null;
	const promptBlocks = new Map<string, string>();
	const transcripts = new Map<string, string>();
	return {
		defs: cachedDefs,
		names: cachedNames,
		toolCallInstructions() {
			if (instructions == null)
				instructions = buildToolCallInstructions(cachedNames);
			return instructions;
		},
		inlinePromptBlock(toolChoiceInstruction?: unknown) {
			const key = String(toolChoiceInstruction || "");
			const cached = promptBlocks.get(key);
			if (cached != null) return cached;
			const text = cachedDefs.length
				? buildToolPromptBlock([...cachedDefs], toolChoiceInstruction)
				: "";
			promptBlocks.set(key, text);
			return text;
		},
		contextTranscript(
			toolChoiceInstruction?: unknown,
			filename: unknown = "tools.txt",
		) {
			const key = `${String(filename || "tools.txt")}\x00${String(toolChoiceInstruction || "")}`;
			const cached = transcripts.get(key);
			if (cached != null) return cached;
			const text = buildToolsContextTranscriptFromDefs(
				cachedDefs,
				toolChoiceInstruction,
				filename,
			);
			transcripts.set(key, text);
			return text;
		},
	};
}

function buildToolsContextTranscriptFromDefs(
	toolDefs: readonly ToolPromptDef[] | null | undefined,
	choiceInstruction: unknown,
	filename: unknown,
): string {
	const defs = toolDefs || [];
	const names = toolNamesForPromptSource(defs);
	const sections = [`# ${filename || "tools.txt"}`];
	if (defs.length) {
		sections.push(
			"Available tool descriptions, parameter schemas, and tool-use instructions.",
			`Available tools:\n${JSON.stringify(defs, null, 2)}`,
			`Tool call format instructions:\n${buildToolCallInstructions(names)}`,
		);
	} else {
		sections.push("Tool-use instructions for this request.");
	}
	if (choiceInstruction)
		sections.push(`Tool choice policy:\n${String(choiceInstruction).trim()}`);
	sections.push(GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT);
	return `${sections.filter((section) => String(section || "").trim()).join("\n\n")}\n`;
}
