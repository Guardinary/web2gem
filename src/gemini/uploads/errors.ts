export type ContentPushUploadErrorCode =
	| "content_push_http_status"
	| "content_push_invalid_ref"
	| "content_push_missing_page_token";

export type ContentPushUploadError = Error & {
	code: ContentPushUploadErrorCode;
	status?: number;
	protocol?: string;
};

export function contentPushUploadError(
	code: ContentPushUploadErrorCode,
	message: string,
	meta: { status?: number; protocol?: string } = {},
): ContentPushUploadError {
	const err = new Error(message) as ContentPushUploadError;
	err.code = code;
	if (meta.status !== undefined) err.status = meta.status;
	if (meta.protocol) err.protocol = meta.protocol;
	return err;
}

export function validateContentPushFileRef(
	raw: unknown,
	protocol: string,
): string {
	const fileRef = String(raw || "").trim();
	if (!fileRef.startsWith("/")) {
		throw contentPushUploadError(
			"content_push_invalid_ref",
			`invalid ${protocol} file ref: ${fileRef.slice(0, 120)}`,
			{ protocol },
		);
	}
	return fileRef;
}
