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
	Expand: "展开",
	Collapse: "收起",
	Label: "标签",
	"Optional display label": "可选显示名称",
	"Value only": "仅填写值",
	"Batch import": "批量导入",
	"One account per line: PSID PSIDTS label": "每行一个账号：PSID PSIDTS 标签",
	"PSID PSIDTS label": "PSID PSIDTS 标签",
	Import: "导入",
	Importing: "导入中",
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
	"Select at least one account": "请至少选择一个账号",
	"Update failed": "更新失败",
	"Delete account?": "删除账号？",
	"Delete accounts?": "删除多个账号？",
	"This action permanently deletes the selected account metadata and cannot be undone.":
		"此操作会永久删除所选账号元数据，且无法撤销。",
	"Delete account": "删除账号",
	"Delete accounts": "删除多个账号",
	available: "可用",
	cooling: "冷却中",
	attention: "需处理",
	disabled: "已禁用",
	auth: "认证失败",
	rate_limit: "限流",
	user_action: "需人工处理",
	location: "地区或 IP 受限",
	transient: "暂时失败",
} as const;

export type TranslationKey = keyof typeof zh;

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

export function tr(key: TranslationKey): string {
	return language.value === "zh-CN" ? zh[key] : key;
}

export function statusLabel(value: string): string {
	return value in zh ? tr(value as TranslationKey) : value.replaceAll("_", " ");
}

function syncDocumentLanguage(): void {
	document.documentElement.lang = language.value;
}
