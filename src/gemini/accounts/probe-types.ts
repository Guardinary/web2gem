import type { RuntimeConfig } from "../../config";
import type { GeminiAccountIssue } from "./domain";

export type GeminiAccountVerificationLevel = "session" | "status";

export type GeminiAccountProbe = {
	statusCode: number;
	issue: GeminiAccountIssue | null;
	models: {
		modelId: string;
		displayName: string;
		description: string;
		available: boolean;
		capacity: number;
		capacityField: number;
		modelNumber: number;
		discoveryOrder: number;
	}[];
};

export type GeminiAccountVerificationResult =
	| { ok: true; probe?: GeminiAccountProbe }
	| {
			ok: false;
			reason: "missing_page_at_token" | "status_probe_failed";
	  };

export type GeminiAccountVerifier = (input: {
	config: RuntimeConfig;
	level: GeminiAccountVerificationLevel;
}) => Promise<GeminiAccountVerificationResult>;
