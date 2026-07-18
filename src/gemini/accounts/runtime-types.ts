import type { GeminiPublicFamily } from "../../models";
import type { GeminiAccountIssue } from "./domain";
import type { GeminiAccountCookieRotator } from "./lease-types";
import type { GeminiAccountProbe, GeminiAccountVerifier } from "./probe-types";
import type {
	GeminiAccountCapabilityRow,
	GeminiModelRoutePriorityRow,
	GeminiRouteTuple,
} from "./route-types";
import type { GeminiAccountRow, GeminiAccountSecretRow } from "./storage-types";

export type GeminiAccountSnapshotRow = Pick<
	GeminiAccountRow,
	| "id"
	| "enabled"
	| "cookie_header"
	| "cookie_hash"
	| "issue"
	| "cooldown_until_ms"
	| "last_used_at_ms"
	| "last_refresh_success_at_ms"
>;

export type GeminiRefreshedCookieWrite = {
	cookieHeader: string;
	refreshedAtMs: number;
	nowMs: number;
};

export type GeminiRefreshedCookieWriteResult = {
	changed: boolean;
	reason?: "duplicate_cookie";
};

export type GeminiAccountOutcome = {
	kind: "success" | "failure";
	issue?: GeminiAccountIssue;
	cooldownUntilMs?: number;
	recoveryScope?: "none" | "retry_same_account" | "try_next_account";
	nowMs: number;
};

export type GeminiAccountRuntimeStore = {
	getPoolVersion(): Promise<string>;
	listSelectableAccounts(
		nowMs: number,
		limit: number,
	): Promise<GeminiAccountSnapshotRow[]>;
	getAccountForRefresh(
		accountId: string,
	): Promise<GeminiAccountSecretRow | null>;
	tryAcquireRefreshLock(
		accountId: string,
		owner: string,
		expiresAtMs: number,
		nowMs: number,
	): Promise<boolean>;
	releaseRefreshLock(accountId: string, owner: string): Promise<void>;
	writeRefreshedCookie(
		accountId: string,
		update: GeminiRefreshedCookieWrite,
	): Promise<GeminiRefreshedCookieWriteResult>;
	writeAccountOutcome(
		accountId: string,
		outcome: GeminiAccountOutcome,
	): Promise<void>;
	writeAccountProbe?(
		accountId: string,
		probe: GeminiAccountProbe,
		checkedAtMs: number,
	): Promise<void>;
	listAccountCapabilities?(
		accountIds: readonly string[],
	): Promise<GeminiAccountCapabilityRow[]>;
	listAllAccountCapabilities?(
		limit: number,
	): Promise<GeminiAccountCapabilityRow[]>;
	listModelRoutePriorities?(): Promise<GeminiModelRoutePriorityRow[]>;
	replaceModelRoutePriority?(
		family: GeminiPublicFamily,
		routes: readonly GeminiRouteTuple[],
		nowMs: number,
	): Promise<void>;
	clearModelRoutePriority?(
		family: GeminiPublicFamily,
		nowMs: number,
	): Promise<void>;
};

export type GeminiAccountRuntimeOptions = {
	nowMs?: () => number;
	snapshotTtlMs?: number;
	versionProbeTtlMs?: number;
	selectableLimit?: number;
	refreshLockTtlMs?: number;
	rotateCookie?: GeminiAccountCookieRotator;
	verifyAccount?: GeminiAccountVerifier;
};

export type GeminiAccountRouteRequirement = {
	candidates: readonly GeminiRouteTuple[];
	fallbackRoute: GeminiRouteTuple | null;
};

export type GeminiAccountAcquireOptions = {
	excludeAccountIds?: ReadonlySet<string> | readonly string[];
	routeRequirement?: GeminiAccountRouteRequirement;
	capabilityMode?: "off" | "prefer" | "strict";
	capabilityFreshAfterMs?: number;
};
