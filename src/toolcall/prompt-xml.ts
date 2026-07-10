export function promptCDATA(text: unknown): string {
	const raw = String(text || "");
	if (!raw) return "";
	return `<![CDATA[${raw.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

export function xmlEscapeAttr(value: unknown): string {
	return String(value == null ? "" : value)
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function indentPromptParameters(body: unknown, indent: string): string {
	if (!String(body || "").trim())
		return `${indent}<|DSML|parameter name="content"></|DSML|parameter>`;
	return String(body)
		.split("\n")
		.map((line) => (line.trim() ? indent + line : line))
		.join("\n");
}

export function wrapParameter(name: unknown, inner: unknown): string {
	return `<|DSML|parameter name="${xmlEscapeAttr(name)}">${inner}</|DSML|parameter>`;
}
