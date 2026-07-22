import { describe, test } from "vitest";
import {
	contextFilePromptByteCheck,
	contextFileThreshold,
	oversizedInlineContextFailure,
	prepareContextFiles,
	shouldConsiderContextFiles,
} from "../../../src/completion/context-files";
import {
	type ContextFileFailure,
	type ContextFileResult,
	hasCompletionError,
} from "../../../src/completion/types";
import { assert } from "../assertions.js";
import {
	contextFileConfig,
	type RecordedUpload,
	recordedUploadAt,
} from "./_support/context-fixtures.js";

function requireContextFileFailure(
	result: ContextFileResult | ContextFileFailure | null,
): ContextFileFailure {
	if (!result || !hasCompletionError(result)) {
		throw new Error("expected context-file preparation to fail");
	}
	return result;
}

function requireContextFileResult(
	result: ContextFileResult | ContextFileFailure | null,
): ContextFileResult & { error?: undefined } {
	if (!result || hasCompletionError(result)) {
		throw new Error("expected context-file preparation to succeed");
	}
	return result;
}

function requireError(value: unknown): Error {
	if (!(value instanceof Error)) throw new Error("expected an Error cause");
	return value;
}

describe("context-file policy", () => {
	test("builds oversized inline context failure metadata", async () => {
		const cfg = contextFileConfig({ supports_authenticated_session: false });
		const check = contextFilePromptByteCheck(cfg, "x".repeat(40));
		const err = oversizedInlineContextFailure(cfg, "x".repeat(40), check);
		assert.equal(err.code, "gemini_authenticated_session_required");
		assert.equal(err.status, 422);
		assert.equal(err.reason, "large_context");
		assert.equal(err.promptBytes, 11);
		assert.equal(err.promptBytesExact, false);
		assert.match(err.message, /at least 11 UTF-8 bytes > 10/);
	});
	test("decides context-file eligibility without requiring uploads", async () => {
		const cfg = contextFileConfig();
		const check = contextFilePromptByteCheck(cfg, "x".repeat(40));
		assert.equal(contextFileThreshold({ current_input_file_min_bytes: -1 }), 0);
		assert.equal(
			contextFileThreshold({
				current_input_file_min_bytes: "not-a-number",
			}),
			95000,
		);
		assert.equal(
			shouldConsiderContextFiles(
				{ ...cfg, current_input_file_enabled: false },
				"x".repeat(40),
			),
			false,
		);
		assert.equal(
			shouldConsiderContextFiles(
				{ ...cfg, supports_authenticated_session: false },
				"x".repeat(40),
			),
			false,
		);
		assert.equal(shouldConsiderContextFiles(cfg, "short"), false);
		assert.equal(shouldConsiderContextFiles(cfg, "x".repeat(40), check), true);
		// Eligibility without latest/history is exercised by prepareContextFiles
		// returning null rather than a private shouldUse helper.
		assert.equal(
			await prepareContextFiles(
				cfg,
				"",
				null,
				"",
				"latest request",
				"x".repeat(40),
				undefined,
				check,
			),
			null,
		);
		assert.equal(
			await prepareContextFiles(
				cfg,
				"history",
				null,
				"",
				"   ",
				"x".repeat(40),
				undefined,
				check,
			),
			null,
		);
	});
	test("formats latest context-file prompt around the inline byte limit", async () => {
		const smallCfg = contextFileConfig({
			current_input_file_min_bytes: 12,
		});
		const uploads: RecordedUpload[] = [];
		const shortResult = requireContextFileResult(
			await prepareContextFiles(
				smallCfg,
				"prior conversation",
				null,
				"",
				"  short latest  ",
				"x".repeat(40),
				async (text, filename) => {
					uploads.push({ text, filename });
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			),
		);
		assert.match(shortResult.prompt, /Latest user request:\nshort latest/);

		const longUploads: RecordedUpload[] = [];
		const longResult = requireContextFileResult(
			await prepareContextFiles(
				smallCfg,
				"prior conversation",
				null,
				"",
				"x".repeat(5000),
				"x".repeat(40),
				async (text, filename) => {
					longUploads.push({ text, filename });
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			),
		);
		assert.match(
			longResult.prompt,
			/latest user request is at the end of `message\.txt`/,
		);
		assert.doesNotMatch(longResult.prompt, /x{100}/);
	});

	test("clamps latest-inline prompt style by context-file threshold", async () => {
		// latestInputInlineLimit = max(4000, min(16000, floor(threshold/6)))
		// threshold 24000 -> 4000; threshold 120000 -> 16000.
		const lowThreshold = contextFileConfig({
			current_input_file_min_bytes: 24000,
		});
		const highThreshold = contextFileConfig({
			current_input_file_min_bytes: 120000,
		});
		const uploader = async (text: string, filename: string) => ({
			ref: `/uploaded/${filename}`,
			name: filename,
		});

		const underLow = requireContextFileResult(
			await prepareContextFiles(
				lowThreshold,
				"history",
				null,
				"",
				"x".repeat(3999),
				"x".repeat(30000),
				uploader,
			),
		);
		assert.match(underLow.prompt, /Latest user request:\nx{10,}/);

		const overLow = requireContextFileResult(
			await prepareContextFiles(
				lowThreshold,
				"history",
				null,
				"",
				"x".repeat(4001),
				"x".repeat(30000),
				uploader,
			),
		);
		assert.match(
			overLow.prompt,
			/latest user request is at the end of `message\.txt`/,
		);

		const underHigh = requireContextFileResult(
			await prepareContextFiles(
				highThreshold,
				"history",
				null,
				"",
				"x".repeat(15999),
				"x".repeat(130000),
				uploader,
			),
		);
		assert.match(underHigh.prompt, /Latest user request:\nx{10,}/);

		const overHigh = requireContextFileResult(
			await prepareContextFiles(
				highThreshold,
				"history",
				null,
				"",
				"x".repeat(16001),
				"x".repeat(130000),
				uploader,
			),
		);
		assert.match(
			overHigh.prompt,
			/latest user request is at the end of `message\.txt`/,
		);
	});
	test("returns upload failure metadata when large context has no uploader", async () => {
		const cfg = contextFileConfig();
		const check = contextFilePromptByteCheck(cfg, "x".repeat(40));
		const result = requireContextFileFailure(
			await prepareContextFiles(
				cfg,
				"prior conversation",
				null,
				"",
				"latest request",
				"x".repeat(40),
				undefined,
				check,
			),
		);
		assert.equal(result.error.code, "large_context_file_upload_failed");
		assert.equal(result.error.promptBytes, 11);
		assert.equal(result.error.promptBytesExact, false);
		assert.equal(result.error.thresholdBytes, 10);
		assert.match(
			requireError(result.error.cause).message,
			/text file uploader is not configured/,
		);
	});
	test("refuses oversized inline fallback when history context upload fails", async () => {
		const cfg = contextFileConfig();
		const result = requireContextFileFailure(
			await prepareContextFiles(
				cfg,
				"prior conversation",
				null,
				"",
				"latest request",
				"x".repeat(40),
				async () => {
					throw new Error("history upload broke");
				},
			),
		);
		assert.equal(result.error.code, "large_context_file_upload_failed");
		assert.match(
			result.error.message,
			/failed to upload history context text file/,
		);
		assert.match(
			requireError(result.error.cause).message,
			/history upload broke/,
		);
	});
	test("refuses oversized inline fallback when tools context upload fails", async () => {
		const cfg = contextFileConfig();
		const uploads: RecordedUpload[] = [];
		const result = requireContextFileFailure(
			await prepareContextFiles(
				cfg,
				"prior conversation",
				[
					{
						name: "Read",
						description: "Read a file",
						parameters: { type: "object" },
					},
				],
				"must call Read",
				"latest request",
				"x".repeat(40),
				async (text, filename) => {
					uploads.push({ text, filename });
					if (filename === "tools.txt") throw new Error("tools upload broke");
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			),
		);
		assert.equal(uploads.length, 2);
		assert.equal(result.error.code, "large_context_file_upload_failed");
		assert.match(
			result.error.message,
			/failed to upload tools context text file/,
		);
		assert.match(
			requireError(result.error.cause).message,
			/tools upload broke/,
		);
	});
	test("moves large tool context into the attached tools file", async () => {
		const cfg = contextFileConfig();
		const uploads: RecordedUpload[] = [];
		const result = requireContextFileResult(
			await prepareContextFiles(
				cfg,
				"user history with latest request",
				[
					{
						name: "Read",
						description: "Read a file",
						parameters: { type: "object" },
					},
				],
				"must call Read",
				"latest request",
				"x".repeat(40),
				async (text, filename) => {
					uploads.push({ text, filename });
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			),
		);
		assert.equal(result.error, undefined);
		assert.equal(result.fileRefs.length, 2);
		assert.equal(recordedUploadAt(uploads, 0).filename, "message.txt");
		assert.equal(recordedUploadAt(uploads, 1).filename, "tools.txt");
		assert.match(
			result.prompt,
			/Continue from the latest state in the attached `message\.txt` context/,
		);
		assert.match(
			result.prompt,
			/All text above this sentence is system prompt content/,
		);
		assert.doesNotMatch(result.prompt, /<\|DSML\|tool_calls>/);
		assert.doesNotMatch(result.prompt, /must call Read/);
		assert.doesNotMatch(result.prompt, /Gemini native hidden tool calls/);
		const toolsUpload = recordedUploadAt(uploads, 1);
		assert.match(toolsUpload.text, /Available tool descriptions/);
		assert.match(toolsUpload.text, /Tool call format instructions/);
		assert.match(toolsUpload.text, /<\|DSML\|tool_calls>/);
		assert.match(toolsUpload.text, /Tool choice policy:\nmust call Read/);
		assert.match(toolsUpload.text, /Gemini native hidden tool calls/);
		assert.match(toolsUpload.text, /All of the above is system prompt content/);
		assert.match(result.promptTokenText, /user history/);
		assert.match(result.promptTokenText, /Available tool descriptions/);
		assert.match(result.promptTokenText, /Gemini native hidden tool calls/);
	});
});
