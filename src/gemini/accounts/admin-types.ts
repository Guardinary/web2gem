import type { GeminiPublicFamily } from "../../models";
import type { GeminiAccountIssue, GeminiAccountState } from "./domain";
import type { GeminiKnownTierLabel, GeminiRouteTuple } from "./route-types";

export type GeminiAccountSummary = {
	id: string;
	label: string | null;
	enabled: boolean;
	state: GeminiAccountState;
	issue: GeminiAccountIssue | null;
	cooldown_until_ms: number | null;
	last_issue_at_ms: number | null;
	last_used_at_ms: number | null;
	last_refresh_at_ms: number | null;
	status_checked_at_ms: number | null;
	last_refresh_success_at_ms: number | null;
	created_at_ms: number;
	updated_at_ms: number;
};

export type GeminiAccountAdminFilter = {
	limit: number;
	cursor?: string;
	q?: string;
	state?: GeminiAccountState;
};

export type GeminiAccountSummaryPage = {
	items: GeminiAccountSummary[];
	nextCursor: string | null;
	limit: number;
};

export type GeminiAccountAdminStats = {
	total: number;
	available: number;
	cooling: number;
	attention: number;
	disabled: number;
};

export type GeminiAccountAdminOverview = GeminiAccountSummaryPage & {
	stats: GeminiAccountAdminStats;
};

export type GeminiAccountBulkAction =
	| "enable"
	| "disable"
	| "delete"
	| "refresh";

export type GeminiAccountCreateInput = {
	id?: string;
	label?: string;
	cookieHeader: string;
	identityHash?: string;
	nowMs: number;
};

export type GeminiAccountBulkCreateEntry = {
	cookieHash: string;
	input: GeminiAccountCreateInput & {
		identityHash: string;
	};
};

export type GeminiAccountBulkCreateResult = {
	createdAccountIds: ReadonlySet<string>;
	changedCredentialCount: number;
};

export type GeminiAccountIdentityImportResult = {
	item: GeminiAccountSummary;
	outcome: "created" | "credentials_changed" | "unchanged";
};

export type GeminiAccountUpdate = {
	label?: string | null;
	enabled?: boolean;
	nowMs: number;
};

export type GeminiAccountUpdateResult = {
	item: GeminiAccountSummary | null;
	changed: boolean;
};

type GeminiModelRoutingRoute = GeminiRouteTuple & {
	label: GeminiKnownTierLabel | null;
	available: boolean;
	configured: boolean;
	accountCount: number;
};

type GeminiModelRoutingFamily = {
	family: GeminiPublicFamily;
	publicNames: readonly [string, string];
	configured: boolean;
	routes: readonly GeminiModelRoutingRoute[];
};

export type GeminiModelRoutingOverview = {
	version: string;
	families: readonly GeminiModelRoutingFamily[];
};

export type GeminiAccountAdminStore = {
	getAdminOverview(
		filter: GeminiAccountAdminFilter,
		nowMs: number,
	): Promise<GeminiAccountAdminOverview>;
	findAccountByCookieHash(
		cookieHash: string,
		nowMs: number,
	): Promise<GeminiAccountSummary | null>;
	findAccountByIdentityHash(
		identityHash: string,
		nowMs: number,
	): Promise<GeminiAccountSummary | null>;
	createAccount(input: GeminiAccountCreateInput): Promise<GeminiAccountSummary>;
	importAccountByIdentity?(
		entry: GeminiAccountBulkCreateEntry,
	): Promise<GeminiAccountIdentityImportResult>;
	createAccountsBulk?(
		entries: GeminiAccountBulkCreateEntry[],
	): Promise<GeminiAccountBulkCreateResult>;
	updateAccount(
		accountId: string,
		update: GeminiAccountUpdate,
	): Promise<GeminiAccountUpdateResult>;
	deleteAccount(accountId: string, nowMs: number): Promise<boolean>;
	setAccountsEnabledBulk?(
		accountIds: readonly string[],
		enabled: boolean,
		nowMs: number,
	): Promise<string[]>;
	deleteAccountsBulk?(
		accountIds: readonly string[],
		nowMs: number,
	): Promise<string[]>;
};

export type GeminiAccountMutationError = {
	id?: string;
	code: string;
	message: string;
};

export type GeminiAccountMutationResult = {
	processed: number;
	changed: number;
	unchanged: number;
	failed: number;
	errors?: GeminiAccountMutationError[];
};
