import { signal } from "@preact/signals";

export type Language = "en" | "zh-CN";

const LANGUAGE_STORAGE_KEY = "web2gem_admin_language";

const zh = {
	"Gemini Account Pool": "Gemini 账号池",
	"Account operations console": "账号运维控制台",
	"D1-backed session management": "基于 D1 的会话管理",
	Connected: "已连接",
	Disconnected: "未连接",
	"Skip to accounts": "跳到账号列表",
	Language: "语言",
	Theme: "主题",
	System: "跟随系统",
	Light: "浅色",
	Dark: "深色",
	"Connect to your account pool": "连接账号池",
	"Enter the configured ADMIN_KEY to manage sanitized account metadata.":
		"输入已配置的 ADMIN_KEY，管理脱敏后的账号元数据。",
	"Admin key": "管理密钥",
	Storage: "保存位置",
	Session: "会话",
	Local: "本地",
	Connect: "连接",
	Connecting: "连接中",
	Clear: "清除",
	"Connection settings": "连接设置",
	"Hide connection settings": "收起连接设置",
	"Connected to account pool": "已连接账号池",
	"Admin access is ready. Reopen settings only when credentials need to change.":
		"管理访问已就绪；仅在需要更换凭据时重新打开设置。",
	"Stored only in this browser. Public API keys cannot access admin routes.":
		"仅保存在当前浏览器中；公共 API Key 无法访问管理接口。",
	"Import accounts": "导入账号",
	"Add one account or paste a batch when needed.":
		"按需添加单个账号或粘贴批量数据。",
	Collapse: "收起",
	Label: "标签",
	"Optional display label": "可选显示名称",
	"Value only": "仅填写值",
	"Batch import": "批量导入",
	"One account per line: PSID PSIDTS label": "每行一个账号：PSID PSIDTS 标签",
	Import: "导入",
	Importing: "导入中",
	Update: "更新",
	Reset: "重置",
	Overview: "概览",
	Total: "总数",
	Available: "可用",
	"Needs attention": "需处理",
	Disabled: "已禁用",
	Cooling: "冷却中",
	"Primary metrics": "核心指标",
	Selected: "已选择",
	"Account workspace": "账号工作区",
	"Search accounts and manage their availability.": "搜索账号并管理其可用性。",
	Search: "搜索",
	"Label or account ID": "标签或账号 ID",
	State: "状态",
	"All states": "全部状态",
	"Clear filters": "清除筛选",
	"Select accounts to unlock bulk actions.": "选择账号后可使用批量操作。",
	Apply: "应用",
	Refresh: "刷新",
	"Select visible": "选择当前页",
	"Clear selection": "清除选择",
	"Delete selected": "删除所选",
	"Delete visible": "删除当前页",
	Select: "选择",
	Account: "账号",
	"Current issue": "当前问题",
	"Last refresh": "最近刷新",
	"Status checked": "状态检查",
	Actions: "操作",
	More: "更多",
	Rename: "重命名",
	Refreshing: "刷新中",
	Enable: "启用",
	Disable: "禁用",
	Delete: "删除",
	Previous: "上一页",
	Next: "下一页",
	"No accounts found": "未找到账号",
	"Connect with an admin key or adjust the current filters.":
		"请连接管理密钥，或调整当前筛选条件。",
	"Loading accounts": "正在加载账号",
	Success: "操作成功",
	Error: "操作失败",
	"Last used": "最近使用",
	"Rename account": "重命名账号",
	"Save changes": "保存更改",
	Saving: "保存中",
	Cancel: "取消",
	Close: "关闭",
	"Display label": "显示名称",
	"Admin key saved": "管理密钥已保存",
	"Admin key cleared": "管理密钥已清除",
	"Admin key is required": "需要管理密钥",
	"Failed to load accounts": "账号加载失败",
	"Import failed": "导入失败",
	"Batch row credentials required": "每行必须包含 PSID 和 PSIDTS",
	"Select at least one account": "请至少选择一个账号",
	"Update failed": "更新失败",
	"Delete account?": "删除账号？",
	"Delete accounts?": "删除多个账号？",
	"This action permanently deletes the selected account metadata and cannot be undone.":
		"此操作会永久删除所选账号元数据，且无法撤销。",
	"Delete account": "删除账号",
	"Delete accounts": "删除多个账号",
	"Internal routing": "内部路由",
	"Model route priority": "模型路由优先级",
	"Public names share one ordered internal policy per family.":
		"每个模型族的公开名称共享同一套内部路由顺序。",
	"Loading model routing": "正在加载模型路由",
	"Model routing is unavailable": "模型路由暂不可用",
	"Connect to configure model routing": "连接后可配置模型路由",
	Configured: "已配置",
	"Discovery order": "发现顺序",
	"Move up": "上移",
	"Move down": "下移",
	Unavailable: "不可用",
	Capacity: "容量",
	Field: "字段",
	"Model number": "模型编号",
	accounts: "个账号",
	"Saved route": "已保存路线",
	"No discovered routes": "暂无发现的路线",
	"Unsaved order": "顺序尚未保存",
	"Reset to discovery order": "恢复发现顺序",
	"Save order": "保存顺序",
	"Pro family": "Pro 模型族",
	"Flash family": "Flash 模型族",
	"Flash Lite family": "Flash Lite 模型族",
	"Failed to load model routing": "模型路由加载失败",
	"Failed to save model routing": "模型路由保存失败",
	"Failed to reset model routing": "模型路由重置失败",
	"Model routing saved": "模型路由已保存",
	"Model routing reset": "模型路由已重置",
	available: "可用",
	cooling: "冷却中",
	attention: "需处理",
	disabled: "已禁用",
	auth: "认证失败",
	rate_limit: "限流",
	user_action: "需人工处理",
	location: "地区或 IP 受限",
	transient: "暂时失败",
	"selected account(s)": "所选账号",
	"loaded account(s)": "当前加载的账号",
} as const;

export type TranslationKey = keyof typeof zh;

type TranslationTemplateParameters = {
	"Loaded account count": { count: number };
	"Pager summary": { page: number; count: number };
	"Pager summary at end": { page: number; count: number };
	"Mutation summary": {
		action: string;
		processed: number;
		changed: number;
		unchanged: number;
		failed: number;
	};
	"Mutation summary with error": TranslationTemplateParameters["Mutation summary"] & {
		error: string;
	};
	"Action failure": { action: string };
	"Delete account title": { count: number };
	"Delete accounts title": { count: number };
	"Delete confirmation description": { count: number; target: string };
	"Delete account action": { count: number };
	"Delete accounts action": { count: number };
	"Busy action": { action: string };
	"Relative future": { amount: number; unit: string };
	"Relative past": { amount: number; unit: string };
	"Select account": { label: string };
	"Refresh account": { label: string };
	"More account actions": { label: string };
	"Account target": { label: string };
	"Move route up": { model: string };
	"Move route down": { model: string };
	"Selected count": { count: number };
	"Cookie value required": { name: string };
	"Cookie value only": { name: string };
};

const templateEn = {
	"Loaded account count": "Loaded {count} accounts",
	"Pager summary": "Page {page} · {count} loaded",
	"Pager summary at end": "Page {page} · {count} loaded · end",
	"Mutation summary":
		"{action} completed: processed {processed}, changed {changed}, unchanged {unchanged}, failed {failed}",
	"Mutation summary with error":
		"{action} completed: processed {processed}, changed {changed}, unchanged {unchanged}, failed {failed} - {error}",
	"Action failure": "{action} failed",
	"Delete account title": "Delete account?",
	"Delete accounts title": "Delete {count} accounts?",
	"Delete confirmation description":
		"This permanently deletes {count} {target}. This action cannot be undone.",
	"Delete account action": "Delete account",
	"Delete accounts action": "Delete {count} accounts",
	"Busy action": "{action} in progress",
	"Relative future": "in {amount}{unit}",
	"Relative past": "{amount}{unit} ago",
	"Select account": "Select {label}",
	"Refresh account": "Refresh {label}",
	"More account actions": "More {label}",
	"Account target": "account “{label}”",
	"Move route up": "Move up {model}",
	"Move route down": "Move down {model}",
	"Selected count": "{count} Selected",
	"Cookie value required": "{name} is required",
	"Cookie value only": "{name} must be a value only",
} as const;

const templateZh: Record<keyof typeof templateEn, string> = {
	"Loaded account count": "已加载 {count} 个账号",
	"Pager summary": "第 {page} 页 · 已加载 {count} 个",
	"Pager summary at end": "第 {page} 页 · 已加载 {count} 个 · 已到底",
	"Mutation summary":
		"{action}完成：处理 {processed}，变更 {changed}，未变更 {unchanged}，失败 {failed}",
	"Mutation summary with error":
		"{action}完成：处理 {processed}，变更 {changed}，未变更 {unchanged}，失败 {failed} - {error}",
	"Action failure": "{action}失败",
	"Delete account title": "删除账号？",
	"Delete accounts title": "删除 {count} 个账号？",
	"Delete confirmation description":
		"此操作会永久删除 {count} 个{target}，且无法撤销。",
	"Delete account action": "删除账号",
	"Delete accounts action": "删除 {count} 个账号",
	"Busy action": "{action}进行中",
	"Relative future": "{amount}{unit}后",
	"Relative past": "{amount}{unit}前",
	"Select account": "选择 {label}",
	"Refresh account": "刷新 {label}",
	"More account actions": "{label} 的更多操作",
	"Account target": "账号“{label}”",
	"Move route up": "上移 {model}",
	"Move route down": "下移 {model}",
	"Selected count": "已选择 {count} 个",
	"Cookie value required": "需要填写 {name}",
	"Cookie value only": "{name} 只能填写值本身",
};

export type TranslationTemplateKey = keyof typeof templateEn;
export type TranslationParameters<K extends TranslationTemplateKey> =
	TranslationTemplateParameters[K];

export const language = signal<Language>("en");

export function detectLanguage(value?: string | null): Language {
	return value?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function initializeLanguage(): void {
	const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
	language.value =
		stored === "en" || stored === "zh-CN"
			? stored
			: detectLanguage(navigator.language);
	syncDocumentLanguage();
}

export function setLanguage(next: Language): void {
	language.value = next;
	window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
	syncDocumentLanguage();
}

export function tr(key: TranslationKey): string;
export function tr<K extends TranslationTemplateKey>(
	key: K,
	params: TranslationParameters<K>,
): string;
export function tr(
	key: TranslationKey | TranslationTemplateKey,
	params?: Record<string, unknown>,
): string {
	if (key in templateEn) {
		const template =
			language.value === "zh-CN"
				? templateZh[key as TranslationTemplateKey]
				: templateEn[key as TranslationTemplateKey];
		return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name) =>
			params && name in params ? String(params[name]) : "",
		);
	}
	return language.value === "zh-CN" ? zh[key as TranslationKey] : key;
}

const actionKeys = {
	import: "Import",
	refresh: "Refresh",
	update: "Update",
	enable: "Enable",
	disable: "Disable",
	delete: "Delete",
} as const satisfies Record<string, TranslationKey>;

export function localActionLabel(action: string, sentence = false): string {
	const key = actionKeys[action as keyof typeof actionKeys];
	if (!key) return action;
	if (sentence && language.value === "en") return action;
	return tr(key);
}

export function relativeUnit(unit: "m" | "h" | "d"): string {
	if (language.value !== "zh-CN") return unit;
	return { m: "分钟", h: "小时", d: "天" }[unit];
}

export function deletionTargetLabel(
	targetLabel: string,
	count: number,
): string {
	const raw = targetLabel.trim() || "selected account(s)";
	const singularized =
		raw === "selected account(s)" || raw === "loaded account(s)"
			? raw.replace("(s)", count === 1 ? "" : "s")
			: raw;
	if (language.value !== "zh-CN") return singularized;
	if (/^loaded account/.test(raw)) return "当前加载的账号";
	if (/^selected account/.test(raw)) return "所选账号";
	const accountLabel = /^account [“\"](.+)[”\"]$/.exec(raw);
	return accountLabel?.[1] ? `账号“${accountLabel[1]}”` : singularized;
}

export function statusLabel(value: string): string {
	return value in zh ? tr(value as TranslationKey) : value.replaceAll("_", " ");
}

function syncDocumentLanguage(): void {
	document.documentElement.lang = language.value;
}
