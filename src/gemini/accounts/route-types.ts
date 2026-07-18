import type {
	GeminiModelCatalogSource,
	GeminiPublicFamily,
} from "../../models";

export type GeminiRouteTuple = {
	providerModelId: string;
	capacity: 1 | 2 | 3 | 4;
	capacityField: 12 | 13;
	modelNumber: number;
};

export type GeminiKnownTierLabel = "Basic" | "Plus" | "Advanced";

export type GeminiAccountCapabilityRow = {
	account_id: string;
	model_id: string;
	display_name: string;
	description: string;
	available: number;
	capacity: number;
	capacity_field: number;
	model_number: number;
	discovery_order: number;
	checked_at_ms: number;
};

export type GeminiAccountModelCapability = {
	modelId: string;
	displayName: string;
	description: string;
	available: boolean;
	capacity: 1 | 2 | 3 | 4;
	capacityField: 12 | 13;
	modelNumber: number;
	discoveryOrder: number;
	checkedAtMs: number;
};

export type GeminiModelRoutePriorityRow = {
	family: GeminiPublicFamily;
	provider_model_id: string;
	capacity: number;
	capacity_field: number;
	model_number: number;
	priority: number;
	updated_at_ms: number;
};

type GeminiInternalRoute = GeminiRouteTuple & {
	family: GeminiPublicFamily | null;
	displayName: string;
	description: string;
	available: boolean;
	checkedAtMs: number;
	discoveryOrder: number;
};

export type GeminiCatalogRoute = GeminiInternalRoute &
	GeminiModelCatalogSource & {
		accountId: string;
	};
