export type XmlTagInfo = {
	name: string;
	closing: boolean;
	selfClosing: boolean;
	start: number;
	end: number;
	attrs: string;
};

export type XmlElementBlock = {
	name: string;
	attrs: string;
	body: string;
	start: number;
	end: number;
};

const XML_TAG_NAME_RE = /[A-Za-z_][A-Za-z0-9_:-]*/y;

export function decodeCDATA(text: unknown): string {
	const raw = String(text || "");
	const closed = raw.replace(
		/<!\[CDATA\[([\s\S]*?)]]>/g,
		(_m, body: string) => body,
	);
	if (closed !== raw) return closed;
	if (raw.startsWith("<![CDATA[")) return raw.slice("<![CDATA[".length);
	return raw;
}

export function decodeXmlEntities(text: unknown): string {
	return String(text || "")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

export function appendMarkupValue(
	obj: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	if (Object.hasOwn(obj, key)) {
		if (Array.isArray(obj[key])) obj[key].push(value);
		else obj[key] = [obj[key], value];
	} else {
		obj[key] = value;
	}
}

export function parseTagAttributes(attrs: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /\b([a-z0-9_:-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi;
	const source = String(attrs || "");
	let m: RegExpExecArray | null = re.exec(source);
	while (m !== null) {
		const key = m[1];
		if (key) out[key] = decodeXmlEntities(m[3] != null ? m[3] : m[4] || "");
		m = re.exec(source);
	}
	const bare = /\b([a-z0-9_:-]+)\s*=\s*([^\s"'=<>`]+)/gi;
	m = bare.exec(source);
	while (m !== null) {
		const key = m[1];
		if (key && !(key in out)) out[key] = decodeXmlEntities(m[2] || "");
		m = bare.exec(source);
	}
	return out;
}

export function findXmlElementBlocks(
	text: unknown,
	tag: unknown,
): XmlElementBlock[] {
	const source = String(text || "");
	const name = String(tag || "").toLowerCase();
	const out: XmlElementBlock[] = [];
	let pos = 0;
	while (pos < source.length) {
		const start = findNextXmlTag(source, name, pos, false);
		if (!start) break;
		let depth = 1;
		let seek = start.end + 1;
		let end: XmlTagInfo | null = null;
		while (seek < source.length) {
			const next = findNextXmlTag(source, name, seek, null);
			if (!next) break;
			if (next.selfClosing) {
				seek = next.end + 1;
				continue;
			}
			if (next.closing) depth -= 1;
			else depth += 1;
			if (depth === 0) {
				end = next;
				break;
			}
			seek = next.end + 1;
		}
		if (!end) {
			pos = start.end + 1;
			continue;
		}
		out.push({
			name,
			attrs: start.attrs,
			body: source.slice(start.end + 1, end.start),
			start: start.start,
			end: end.end + 1,
		});
		pos = end.end + 1;
	}
	return out;
}

export function findTopLevelXmlElementBlocks(text: unknown): XmlElementBlock[] {
	const source = String(text || "");
	const out: XmlElementBlock[] = [];
	let pos = 0;
	while (pos < source.length) {
		const start = findNextAnyXmlTag(source, pos, false);
		if (!start) break;
		if (start.start > pos && source.slice(pos, start.start).trim()) break;
		if (start.selfClosing) {
			out.push({
				name: start.name,
				attrs: start.attrs,
				body: "",
				start: start.start,
				end: start.end + 1,
			});
			pos = start.end + 1;
			continue;
		}
		let depth = 1;
		let seek = start.end + 1;
		let end: XmlTagInfo | null = null;
		while (seek < source.length) {
			const next = findNextXmlTag(source, start.name, seek, null);
			if (!next) break;
			if (next.selfClosing) {
				seek = next.end + 1;
				continue;
			}
			if (next.closing) depth -= 1;
			else depth += 1;
			if (depth === 0) {
				end = next;
				break;
			}
			seek = next.end + 1;
		}
		if (!end) break;
		out.push({
			name: start.name,
			attrs: start.attrs,
			body: source.slice(start.end + 1, end.start),
			start: start.start,
			end: end.end + 1,
		});
		pos = end.end + 1;
	}
	if (pos < source.length && source.slice(pos).trim()) return [];
	return out;
}

export function findNextXmlTag(
	text: string,
	tag: unknown,
	from: number,
	closing: boolean | null,
): XmlTagInfo | null {
	const wanted = String(tag || "").toLowerCase();
	for (let i = Math.max(0, from || 0); i < text.length; ) {
		i = text.indexOf("<", i);
		if (i < 0) return null;
		const cdataEnd = skipCDATAAt(text, i);
		if (cdataEnd > i) {
			i = cdataEnd;
			continue;
		}
		const tagInfo = scanXmlTagAt(text, i);
		if (
			tagInfo &&
			tagInfo.name === wanted &&
			(closing === null || tagInfo.closing === closing)
		)
			return tagInfo;
		i += 1;
	}
	return null;
}

export function findNextAnyXmlTag(
	text: string,
	from: number,
	closing: boolean | null,
): XmlTagInfo | null {
	for (let i = Math.max(0, from || 0); i < text.length; ) {
		i = text.indexOf("<", i);
		if (i < 0) return null;
		const cdataEnd = skipCDATAAt(text, i);
		if (cdataEnd > i) {
			i = cdataEnd;
			continue;
		}
		const tagInfo = scanXmlTagAt(text, i);
		if (tagInfo && (closing === null || tagInfo.closing === closing))
			return tagInfo;
		i += 1;
	}
	return null;
}

export function skipCDATAAt(text: string, i: number): number {
	if (!text.startsWith("<![CDATA[", i)) return i;
	const end = text.indexOf("]]>", i + 9);
	return end < 0 ? i : end + 3;
}

export function scanXmlTagAt(text: string, i: number): XmlTagInfo | null {
	if (text[i] !== "<") return null;
	let p = i + 1;
	let closing = false;
	if (text[p] === "/") {
		closing = true;
		p += 1;
	}
	XML_TAG_NAME_RE.lastIndex = p;
	const m = XML_TAG_NAME_RE.exec(text);
	if (!m) return null;
	const name = m[0].toLowerCase();
	p += m[0].length;
	const nextChar = text[p];
	if (p < text.length && (nextChar === undefined || !/[\s/>]/.test(nextChar)))
		return null;
	const end = findXmlTagEnd(text, p);
	if (end < 0) return null;
	const attrsEnd = text[end - 1] === "/" ? end - 1 : end;
	return {
		name,
		closing,
		selfClosing: !closing && text[end - 1] === "/",
		start: i,
		end,
		attrs: text.slice(p, attrsEnd),
	};
}

export function findXmlTagEnd(text: string, from: number): number {
	let quote = "";
	for (let i = Math.max(0, from || 0); i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ">") return i;
	}
	return -1;
}
