import { describe, test } from "vitest";
import {
	contentPushUploadError,
	type ContentPushUploadError,
	validateContentPushFileRef,
} from "../../../../src/gemini/uploads/errors";
import { contentPushUploadTokens } from "../../../../src/gemini/uploads/tokens";
import { assert } from "../../assertions.js";

function isContentPushUploadError(
	error: unknown,
): error is ContentPushUploadError {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return (
		error.code === "content_push_http_status" ||
		error.code === "content_push_invalid_ref" ||
		error.code === "content_push_missing_page_token"
	);
}

function captureError(run: () => unknown): ContentPushUploadError {
	try {
		run();
	} catch (error) {
		if (isContentPushUploadError(error)) return error;
		throw error;
	}
	throw new Error("expected operation to fail");
}

describe("content-push upload errors", () => {
	test("requires a non-empty push ID with protocol metadata", () => {
		assert.deepEqual(contentPushUploadTokens(" push-id ", "multipart"), {
			pushId: "push-id",
		});
		const error = captureError(() =>
			contentPushUploadTokens("  ", "multipart"),
		);
		assert.equal(error.code, "content_push_missing_page_token");
		assert.equal(error.protocol, "multipart");
		assert.match(error.message, /missing Gemini page token: push_id/);
	});

	test("validates file refs and preserves structured error metadata", () => {
		assert.equal(
			validateContentPushFileRef("  /uploaded/ref  ", "multipart"),
			"/uploaded/ref",
		);
		const invalid = captureError(() =>
			validateContentPushFileRef("not-a-ref", "multipart"),
		);
		assert.equal(invalid.code, "content_push_invalid_ref");
		assert.equal(invalid.protocol, "multipart");
		assert.match(invalid.message, /invalid multipart file ref/);

		const status = contentPushUploadError(
			"content_push_http_status",
			"upload failed",
			{ status: 503, protocol: "multipart" },
		);
		assert.equal(status.code, "content_push_http_status");
		assert.equal(status.status, 503);
		assert.equal(status.protocol, "multipart");
	});
});
