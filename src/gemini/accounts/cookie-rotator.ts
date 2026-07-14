import type { RuntimeConfig } from "../../config";
import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import type {
	GeminiAccountRotateResponse,
	GeminiAccountSecretRow,
} from "./types";

export async function rotateGeminiAccountCookie(input: {
	config: RuntimeConfig;
	account: GeminiAccountSecretRow;
}): Promise<GeminiAccountRotateResponse> {
	return httpFetch("https://accounts.google.com/RotateCookies", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: "https://accounts.google.com",
			Referer: "https://accounts.google.com/",
			"User-Agent": GEMINI_WEB_USER_AGENT,
			"Accept-Language": "en-US,en;q=0.9",
			Cookie: input.account.cookie_header,
		},
		body: '[000,"-0000000000000000000"]',
		timeoutMs: Math.min(
			Math.max(Number(input.config.request_timeout_sec) || 30, 1) * 1000,
			30000,
		),
		socket: input.config.upstream_socket,
		socketFallback: "never",
		cfg: input.config,
	});
}
