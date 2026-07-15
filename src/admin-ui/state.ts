import { signal } from "@preact/signals";
import type {
	AccountStats,
	GeminiAccount,
	GeminiAccountState,
	ModelFamily,
	ModelRoutingDraft,
	ModelRoutingOverview,
} from "./types";

export const KEY_STORAGE = "web2gem_gemini_admin_key";
export const KEY_STORAGE_MODE = "web2gem_gemini_admin_key_storage";

export const accountStates = [
	"available",
	"cooling",
	"attention",
	"disabled",
] as const satisfies readonly GeminiAccountState[];

export type ToastItem = { id: number; message: string; kind?: "error" };
export type ConfirmationDraft = {
	action: "delete";
	count: number;
	targetLabel: string;
};
export type EditDraft = { key: string; label: string };

export const adminKey = signal("");
export const connectionVerified = signal(false);
export const accounts = signal<GeminiAccount[]>([]);
export const selected = signal<Set<string>>(new Set());
export const loading = signal(false);
export const query = signal("");
export const stateFilter = signal<GeminiAccountState | "">("");
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
export const importBusy = signal(false);
export const editBusy = signal(false);
export const batchBusy = signal("");
export const rowBusy = signal<Record<string, string>>({});
export const confirmationDraft = signal<ConfirmationDraft | null>(null);
export const importExpanded = signal(false);
export const authExpanded = signal(false);
export const modelRouting = signal<ModelRoutingOverview | null>(null);
export const modelRoutingLoading = signal(false);
export const modelRoutingDrafts = signal<
	Record<ModelFamily, ModelRoutingDraft>
>(emptyModelRoutingDrafts());

export function emptyModelRoutingDrafts(): Record<
	ModelFamily,
	ModelRoutingDraft
> {
	return {
		pro: { routes: [], busy: false, error: null, dirty: false },
		flash: { routes: [], busy: false, error: null, dirty: false },
		flash_lite: { routes: [], busy: false, error: null, dirty: false },
	};
}
