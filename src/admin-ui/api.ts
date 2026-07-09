import { parseMutation, parsePage } from "./schemas";
import type { AccountIdentifier, AccountPage, MutationResult } from "./types";

const API_PATH = "/admin/accounts";

export type ListOptions = {
  adminKey: string;
  cursor?: string;
  status?: string;
  enabled?: string;
};

export type CreateInput = {
  label?: string;
  psid: string;
  psidts: string;
};

export type UpdateInput = AccountIdentifier & {
  label: string | null;
  status: string;
  enabled: boolean;
  state_reason: string | null;
  source: string | null;
  source_name: string | null;
};

function headers(adminKey: string, json: boolean): HeadersInit {
  const normalized = adminKey.trim();
  if (!normalized) throw new Error("Admin key is required");
  return json ? { Authorization: `Bearer ${normalized}`, "Content-Type": "application/json" } : { Authorization: `Bearer ${normalized}` };
}

async function request(adminKey: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const hasBody = Object.prototype.hasOwnProperty.call(init, "body");
  const requestInit: RequestInit = {
    method: init.method || "GET",
    headers: headers(adminKey, hasBody),
  };
  if (hasBody) requestInit.body = JSON.stringify(init.body ?? {});
  const response = await fetch(path, requestInit);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? ((body.error as { message?: string; code?: string }).message || (body.error as { code?: string }).code)
      : "";
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  return body;
}

export async function listAccounts(options: ListOptions): Promise<AccountPage> {
  const params = new URLSearchParams({ limit: "200" });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.status) params.set("status", options.status);
  if (options.enabled) params.set("enabled", options.enabled);
  return parsePage(await request(options.adminKey, `${API_PATH}?${params.toString()}`));
}

export async function createAccount(adminKey: string, input: CreateInput): Promise<MutationResult> {
  const payload: Record<string, string> = {
    provider: "gemini",
    "__Secure-1PSID": input.psid,
    "__Secure-1PSIDTS": input.psidts,
  };
  if (input.label) payload.label = input.label;
  return parseMutation(await request(adminKey, API_PATH, { method: "POST", body: payload }));
}

export async function updateAccount(adminKey: string, input: UpdateInput): Promise<MutationResult> {
  return parseMutation(await request(adminKey, API_PATH, { method: "PATCH", body: input }));
}

export async function runAccountAction(adminKey: string, action: string, identifiers: AccountIdentifier[]): Promise<MutationResult> {
  const method = action === "delete" ? "DELETE" : "POST";
  const suffix = action === "delete" ? "" : `/${action}`;
  return parseMutation(await request(adminKey, `${API_PATH}${suffix}`, { method, body: { identifiers } }));
}
