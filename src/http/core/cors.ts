const DEFAULT_CORS_ALLOW_HEADERS = [
	"Content-Type",
	"Authorization",
	"OpenAI-Organization",
	"OpenAI-Project",
	"OpenAI-Beta",
	"X-API-Key",
	"X-Goog-Api-Key",
	"X-Stainless-OS",
	"X-Stainless-Arch",
	"X-Stainless-Lang",
	"X-Stainless-Package-Version",
	"X-Stainless-Runtime",
	"X-Stainless-Runtime-Version",
	"X-Client-Version",
	"X-Requested-With",
	"HTTP-Referer",
	"X-Title",
];

const DEFAULT_CORS_ALLOW_HEADERS_VALUE = DEFAULT_CORS_ALLOW_HEADERS.join(", ");

export function corsHeaders(request: Request): Record<string, string> {
	const origin = String(request.headers.get("Origin") || "").trim();
	const headers: Record<string, string> = {
		"Access-Control-Allow-Origin": origin || "*",
		"Access-Control-Allow-Headers": buildCORSAllowHeaders(request),
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Max-Age": "600",
		Vary: "Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
	};
	if (
		/^true$/i.test(
			String(
				request.headers.get("Access-Control-Request-Private-Network") || "",
			).trim(),
		)
	) {
		headers["Access-Control-Allow-Private-Network"] = "true";
	}
	return headers;
}

function buildCORSAllowHeaders(request: Request): string {
	const requested = request.headers.get("Access-Control-Request-Headers") || "";
	if (!String(requested || "").trim()) return DEFAULT_CORS_ALLOW_HEADERS_VALUE;
	const names: string[] = [];
	const seen = new Set<string>();
	const append = (name: unknown) => {
		const headerName = String(name || "").trim();
		if (!isValidCORSHeaderToken(headerName)) return;
		const key = headerName.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		names.push(headerName);
	};
	for (const name of DEFAULT_CORS_ALLOW_HEADERS) append(name);
	for (const name of splitCORSRequestHeaders(requested)) append(name);
	return names.join(", ");
}

function splitCORSRequestHeaders(raw: unknown): string[] {
	if (!String(raw || "").trim()) return [];
	return String(raw)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function isValidCORSHeaderToken(v: unknown): boolean {
	return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(String(v || ""));
}

export function withCORS(response: Response, request: Request): Response {
	return withHeaders(response, Object.entries(corsHeaders(request)));
}

// Set headers in place; clone the response when the platform hands us one
// with immutable headers.
export function withHeaders(
	response: Response,
	entries: readonly (readonly [string, string])[],
): Response {
	try {
		for (const [key, value] of entries) response.headers.set(key, value);
		return response;
	} catch (_) {}
	const headers = new Headers(response.headers);
	for (const [key, value] of entries) headers.set(key, value);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
