import type { RuntimeConfig } from "../config";
import type { ResolvedModel } from "../models";
import { logStage } from "../shared/logging";
import type { ErrorWithMetadata } from "../shared/types";
import { basicRouteForFamily, type GeminiRouteTuple } from "./accounts/routes";
import type { GeminiAccountLease } from "./accounts/types";

type ResolvedModelOK = Extract<ResolvedModel, { name: string }>;

export function logGeminiRoute(
	cfg: RuntimeConfig,
	model: ResolvedModelOK,
	stream: boolean,
): void {
	logStage(cfg, "gemini_route", {
		model: model.name,
		modelFamily: model.family || "dynamic",
		extendedThinking: model.extended,
		dynamicProvider: !!model.dynamicProviderId,
		stream,
	});
}

export function routeForModelAndLease(
	model: ResolvedModelOK,
	lease: GeminiAccountLease | null,
): GeminiRouteTuple {
	if (lease?.selectedRoute) return lease.selectedRoute;
	if (model.dynamicProviderId)
		throw routeNotSelectedError("dynamic Gemini model route was not selected");
	if (!model.family) throw routeNotSelectedError("model has no Gemini route");
	const route = basicRouteForFamily(model.family);
	const capability = lease?.modelCapability;
	if (
		!capability?.available ||
		capability.modelId !== route.providerModelId ||
		(capability.capacityField !== 12 && capability.capacityField !== 13) ||
		(capability.capacity !== 1 &&
			capability.capacity !== 2 &&
			capability.capacity !== 3 &&
			capability.capacity !== 4)
	)
		return route;
	return {
		...route,
		capacity: capability.capacity,
		capacityField: capability.capacityField,
	};
}

function routeNotSelectedError(message: string): ErrorWithMetadata {
	const error: ErrorWithMetadata = new Error(message);
	error.code = "gemini_route_not_selected";
	error.status = 502;
	return error;
}
