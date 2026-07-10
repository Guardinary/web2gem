// ─── 模型 ────────────────────────────────────────────────────────────────
// MODE_CATEGORY 枚举(来自 Gemini 前端 JS):
//   1=FAST, 2=THINKING, 3=PRO, 4=AUTO, 5=FAST_DYNAMIC_THINKING, 6=FLASH_LITE
export type ModelConfig = {
	mode: number;
	think: number;
	desc: string;
	extra?: Record<number, unknown>;
	modelHeaders?: Record<string, string>;
};

export type ResolvedModel =
	| {
			name: string;
			modeId: number;
			thinkMode: number;
			extra: Record<number, unknown> | null;
			modelHeaders: Record<string, string> | null;
			error?: undefined;
	  }
	| {
			error: string;
			name?: undefined;
			modeId?: undefined;
			thinkMode?: undefined;
			extra?: undefined;
	  };

export const MIN_THINK_LEVEL = 0;
export const MAX_THINK_LEVEL = 4;
const MODEL_HEADER_KEY = "x-goog-ext-525001261-jspb";

function webModelHeaders(
	modelId: string,
	capacityTail: number,
): Record<string, string> {
	return {
		[MODEL_HEADER_KEY]: `[1,null,null,null,"${modelId}",null,null,0,[4],null,null,${capacityTail}]`,
		"x-goog-ext-73010989-jspb": "[0]",
		"x-goog-ext-73010990-jspb": "[0]",
	};
}

export const MODELS: Record<string, ModelConfig> = {
	"gemini-3.5-flash": {
		mode: 1,
		think: 4,
		modelHeaders: webModelHeaders("fbb127bbb056c959", 1),
		desc: "Fast general-purpose model",
	},
	"gemini-3.5-flash-thinking": {
		mode: 2,
		think: 0,
		modelHeaders: webModelHeaders("5bf011840784117a", 1),
		desc: "Deep thinking mode, longest output (~20k chars)",
	},
	"gemini-3.1-pro": {
		mode: 3,
		think: 4,
		modelHeaders: webModelHeaders("9d8ca3786ebdfbea", 1),
		desc: "Pro model (requires cookie for real routing)",
	},
	"gemini-3.1-pro-enhanced": {
		mode: 3,
		think: 4,
		extra: { 31: 2, 80: 3 },
		modelHeaders: webModelHeaders("e6fa609c3fa255c0", 2),
		desc: "Pro with enhanced output (experimental)",
	},
	"gemini-auto": { mode: 4, think: 4, desc: "Auto model selection" },
	"gemini-3.5-flash-thinking-lite": {
		mode: 5,
		think: 0,
		desc: "Dynamic thinking with adaptive depth",
	},
	"gemini-flash-lite": { mode: 6, think: 4, desc: "Lightweight fast model" },
};

/**
 * 把模型名解析成路由参数。
 * 未知名称直接报错,避免调用方误以为使用了指定模型。
 * 支持 `@think=N` 后缀来覆盖思考深度。
 * 返回 { name, modeId, thinkMode, extra },或 { error }。
 */
export function resolveModel(modelName: unknown, def: unknown): ResolvedModel {
	const hasExplicitModel = modelName !== undefined && modelName !== null;
	let name = String(hasExplicitModel ? modelName : def || "").trim();
	let thinkOverride: number | null = null;
	if (name.includes("@think=")) {
		const idx = name.lastIndexOf("@think=");
		const thinkStr = name.slice(idx + "@think=".length);
		name = name.slice(0, idx);
		if (!/^\d+$/.test(thinkStr))
			return {
				error: `Invalid think level: ${thinkStr}; supported values are ${MIN_THINK_LEVEL}..${MAX_THINK_LEVEL}`,
			};
		thinkOverride = Number.parseInt(thinkStr, 10);
		if (thinkOverride < MIN_THINK_LEVEL || thinkOverride > MAX_THINK_LEVEL) {
			return {
				error: `Invalid think level: ${thinkStr}; supported values are ${MIN_THINK_LEVEL}..${MAX_THINK_LEVEL}`,
			};
		}
	}
	const cfg = MODELS[name];
	if (!cfg) {
		return { error: `model ${name || "(empty)"} is not available` };
	}
	return {
		name,
		modeId: cfg.mode,
		thinkMode: thinkOverride !== null ? thinkOverride : cfg.think,
		extra: cfg.extra || null,
		modelHeaders: cfg.modelHeaders || null,
	};
}
