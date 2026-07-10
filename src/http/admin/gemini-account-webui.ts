import { GEMINI_ACCOUNT_ADMIN_HTML } from "../../generated/admin-ui";

const ADMIN_UI_PATH = "/admin";

export function isGeminiAccountAdminUiPath(path: string): boolean {
	return path === ADMIN_UI_PATH;
}

export function handleGeminiAccountAdminUiRequest(request: Request): Response {
	if (request.method.toUpperCase() !== "GET") {
		return new Response("admin UI route not found", {
			status: 404,
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"x-content-type-options": "nosniff",
			},
		});
	}
	return new Response(GEMINI_ACCOUNT_ADMIN_HTML, {
		status: 200,
		headers: {
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' blob: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			"content-type": "text/html; charset=utf-8",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		},
	});
}
