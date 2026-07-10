import { isRecord, type UnknownRecord } from "../../shared/types";

export type ImageGenerationMode = {
	enabled: boolean;
	forced: boolean;
	tool: UnknownRecord | null;
};

export function imageGenerationMode(req: UnknownRecord): ImageGenerationMode {
	const choice = isRecord(req.tool_choice) ? req.tool_choice : null;
	if (choice && choice.type === "image_generation") {
		return { enabled: true, forced: true, tool: choice };
	}
	const tools = Array.isArray(req.tools) ? req.tools : [];
	for (const tool of tools) {
		if (isRecord(tool) && tool.type === "image_generation") {
			return { enabled: true, forced: false, tool };
		}
	}
	return { enabled: false, forced: false, tool: null };
}

export function isImageGenerationRequest(req: UnknownRecord): boolean {
	return imageGenerationMode(req).enabled;
}
