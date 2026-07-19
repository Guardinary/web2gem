import type { ModelRoutingRoute } from "./schemas";

export type {
	AccountOverview,
	AccountStats,
	GeminiAccount,
	GeminiAccountIssue,
	GeminiAccountState,
	ModelFamily,
	ModelRoutingFamily,
	ModelRoutingOverview,
	ModelRoutingRoute,
	MutationError,
	MutationResult,
} from "./schemas";

export type AccountIdentifier = { id: string };

export type AccountAction = "enable" | "disable" | "delete" | "refresh";

export type ModelRouteTuple = {
	providerModelId: string;
	capacity: 1 | 2 | 3 | 4;
	capacityField: 12 | 13;
	modelNumber: number;
};
export type ModelRoutingDraft = {
	routes: ModelRoutingRoute[];
	busy: boolean;
	error: string | null;
	dirty: boolean;
};
