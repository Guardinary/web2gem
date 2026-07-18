import type { RuntimeConfig } from "../../config";
import type {
	GeminiAccountModelCapability,
	GeminiRouteTuple,
} from "./route-types";
import type { GeminiAccountSecretRow } from "./storage-types";

export type GeminiAccountCookieRotator = (input: {
	config: RuntimeConfig;
	account: GeminiAccountSecretRow;
}) => Promise<GeminiAccountRotateResponse>;

export type GeminiAccountRotateResponse = {
	status: number;
	ok: boolean;
	headers: Headers;
};

export type GeminiAccountLease = {
	accountId: string;
	selectedRoute: GeminiRouteTuple | null;
	modelCapability: GeminiAccountModelCapability | null;
	config: RuntimeConfig;
	refreshForRetry(reason?: string): Promise<GeminiAccountRefreshResult>;
	markSuccess(nowMs?: number): Promise<void>;
	markFailure(error: unknown, nowMs?: number): Promise<void>;
	flushObservedCookies(): Promise<void>;
	maintainSessionIfStale(intervalMs: number): Promise<void>;
	release(): void;
};

export type GeminiAccountRefreshReason =
	| "missing_secure_1psid"
	| "recent_rotation"
	| "lock_conflict"
	| "account_missing"
	| "rotation_rejected"
	| "rotation_failed"
	| "rotation_no_update"
	| "rotation_duplicate"
	| "rotation_updated"
	| "missing_page_at_token"
	| "status_probe_failed"
	| "status_restricted";

export type GeminiAccountRefreshResult = {
	changed: boolean;
	reason: GeminiAccountRefreshReason;
};
