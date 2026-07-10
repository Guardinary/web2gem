type AuthConfig = { api_keys?: readonly string[] | null | undefined };

// Accept the caller key from Bearer, x-api-key, x-goog-api-key, or ?key=.
export function authorized(
	request: Request,
	url: URL,
	cfg: AuthConfig,
): boolean {
	const keys = cfg.api_keys || [];
	if (!keys.length) return true;
	const h = request.headers;
	const auth = h.get("authorization") || "";
	const bearer = /^\s*Bearer\s+(.+?)\s*$/i.exec(auth);
	const candidates = [
		bearer?.[1] ? bearer[1] : null,
		h.get("x-api-key"),
		h.get("x-goog-api-key"),
		url.searchParams.get("key"),
	];
	for (const raw of candidates) {
		const candidate = String(raw || "").trim();
		if (!candidate) continue;
		let matched = false;
		for (const configured of keys) {
			matched =
				timingSafeStringEqual(candidate, String(configured || "")) || matched;
		}
		if (matched) return true;
	}
	return false;
}

function timingSafeStringEqual(a: string, b: string): boolean {
	const max = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < max; i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}
