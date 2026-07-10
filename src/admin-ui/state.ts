import { signal } from "@preact/signals";
import type { AccountStats, GeminiAccount, MutationResult } from "./types";

export const KEY_STORAGE = "web2gem_gemini_admin_key";
export const KEY_STORAGE_MODE = "web2gem_gemini_admin_key_storage";

export const statuses = [
	"active",
	"disabled",
	"auth_failed",
	"needs_cookie_update",
	"rate_limited",
	"cooling_down",
	"transient_failed",
	"hard_blocked",
	"needs_user_action",
	"missing_cookie",
	"capability_mismatch",
] as const;

export const categories = [
	"full_session",
	"psid_psidts",
	"psid_only",
	"session_token_only",
	"missing_session",
] as const;

export type ToastItem = { id: number; message: string; kind?: "error" };
export type EditDraft = {
	key: string;
	label: string;
	status: string;
	enabled: string;
	stateReason: string;
	source: string;
	sourceName: string;
};

export const adminKey = signal("");
export const accounts = signal<GeminiAccount[]>([]);
export const selected = signal<Set<string>>(new Set());
export const loading = signal(false);
export const query = signal("");
export const statusFilter = signal("");
export const enabledFilter = signal("");
export const categoryFilter = signal("");
export const cooldownFilter = signal("");
export const sourceFilter = signal("");
export const cursorStack = signal<string[]>([""]);
export const pageIndex = signal(0);
export const nextCursor = signal<string | null>(null);
export const toastItems = signal<ToastItem[]>([]);
export const editDraft = signal<EditDraft | null>(null);
export const importLabel = signal("");
export const importPsid = signal("");
export const importPsidts = signal("");
export const importBatch = signal("");
export const keyStorageMode = signal<"session" | "local">("session");
export const accountStats = signal<AccountStats | null>(null);
export const actionBusy = signal("");
export const lastDiagnostics = signal<MutationResult | null>(null);
