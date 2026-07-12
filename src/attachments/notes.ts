import { sanitizeUploadFilename } from "./mime";
import type { AttachmentDrop, AttachmentKind } from "./types";

export function droppedAttachmentNote(
	drops: readonly AttachmentDrop[] | null | undefined,
): string {
	if (!drops?.length) return "";
	const groups = new Map<
		string,
		{ kind: AttachmentKind; message: string; count: number }
	>();
	for (const drop of drops) {
		const key = `${drop.kind}\x00${drop.message}`;
		const existing = groups.get(key);
		if (existing) existing.count += 1;
		else groups.set(key, { kind: drop.kind, message: drop.message, count: 1 });
	}
	return [...groups.values()]
		.map(
			(group) =>
				`\n\n[Note: ${group.count} ${group.kind}(s) were provided but ignored - ${group.message}.]`,
		)
		.join("");
}

export function attachmentDrop(
	kind: AttachmentKind,
	code: AttachmentDrop["code"],
	message?: string,
	filename?: unknown,
): AttachmentDrop {
	const drop: AttachmentDrop = {
		kind,
		code,
		message: message || defaultDropMessage(code),
	};
	const safeName = sanitizeUploadFilename(filename);
	if (safeName) drop.filename = safeName;
	return drop;
}

function defaultDropMessage(code: AttachmentDrop["code"]): string {
	switch (code) {
		case "invalid_image_input":
			return "invalid image input";
		case "invalid_file_input":
			return "invalid file input";
		case "invalid_base64":
			return "invalid base64 payload";
		case "invalid_remote_url":
			return "invalid remote URL";
		case "file_too_large":
			return "file attachment is too large";
		case "image_too_large":
			return "image attachment is too large";
		case "too_many_files":
			return "too many attachments";
		case "upload_failed":
			return "attachment upload failed";
	}
}
