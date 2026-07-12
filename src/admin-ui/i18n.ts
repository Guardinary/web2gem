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
	Refreshable: "可刷新",
	Cooling: "冷却中",
	"PSID only": "仅 PSID",
	"Success / fail": "成功 / 失败",
	Selected: "已选择",
	"Primary metrics": "核心指标",
	"Operational metrics": "运维指标",
	"Account workspace": "账号工作区",
	"Search, filter, inspect, and operate on sanitized account metadata.":
		"搜索、筛选、检查并操作脱敏后的账号元数据。",
	Search: "搜索",
	"Label, ID, source, status": "标签、ID、来源、状态",
	Status: "状态",
	"All statuses": "全部状态",
	Enabled: "启用状态",
	All: "全部",
	Category: "类型",
	"All categories": "全部类型",
	Cooldown: "冷却",
	"Not cooling": "未冷却",
	Source: "来源",
	"More filters": "更多筛选",
	"Hide filters": "收起筛选",
	"Clear filters": "清除筛选",
	"Select accounts to unlock bulk actions.": "选择账号后可使用批量操作。",
	Apply: "应用",
	Refresh: "刷新",
	"Select visible": "选择当前页",
	"Clear selection": "清除选择",
	"Check selected": "检查所选",
	"Refresh selected": "刷新所选",
	"Enable selected": "启用所选",
	"Disable selected": "禁用所选",
	"Delete selected": "删除所选",
	"Delete visible": "删除当前页",
	"Export CSV": "导出 CSV",
	Select: "选择",
	Account: "账号",
	Used: "最近使用",
	"Last success": "最近成功",
	"Last failure": "最近失败",
	Outcome: "结果",
	Errors: "错误",
	Actions: "操作",
	Check: "检查",
	Checking: "检查中",
	More: "更多",
	Edit: "编辑",
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
	"More account details": "更多账号详情",
	"Last error": "最近错误",
	Diagnostics: "诊断结果",
	"Latest sanitized mutation summary": "最近一次脱敏操作摘要",
	"Edit account": "编辑账号",
	"State reason": "状态原因",
	"Source name": "来源名称",
	"Save changes": "保存更改",
	Saving: "保存中",
	Cancel: "取消",
	Close: "关闭",
	"Display label": "显示名称",
	"Optional status note": "可选状态说明",
	"Optional source": "可选来源",
	"Optional source name": "可选来源名称",
	"Admin key saved": "管理密钥已保存",
	"Admin key cleared": "管理密钥已清除",
	"No accounts to export": "没有可导出的账号",
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
	active: "正常",
	disabled: "已禁用",
	auth_failed: "认证失败",
	needs_cookie_update: "需更新凭据",
	rate_limited: "受限流",
	cooling_down: "冷却中",
	transient_failed: "暂时失败",
	hard_blocked: "已封锁",
	needs_user_action: "需人工处理",
	missing_cookie: "缺少凭据",
	capability_mismatch: "能力不匹配",
	check: "检查",
	refresh: "刷新",
	enable: "启用",
	disable: "禁用",
	delete: "删除",
	full_session: "完整会话",
	psid_psidts: "PSID + PSIDTS",
	psid_only: "仅 PSID",
	session_token_only: "仅会话令牌",
	missing_session: "缺少会话",
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
