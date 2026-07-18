import { describe, test } from "vitest";
import {
	contextFilePromptByteCheck,
	contextFileThreshold,
	contextFileUploadFailure,
	latestInputInlineLimit,
	latestInputPromptForContextFile,
	oversizedInlineContextFailure,
	prepareContextFiles,
	prepareContextFilesWithUploader,
	shouldConsiderContextFiles,
	shouldUseContextFiles,
} from "../../../src/completion/context-files";
import { assert } from "../assertions.js";

describe("context-file policy", () => {
	test("builds oversized inline context failure metadata", async () => {
		const check = contextFilePromptByteCheck(
			{
				current_input_file_enabled: true,
				current_input_file_min_bytes: 10,
				supports_authenticated_session: false,
			},
			"x".repeat(40),
		);
		const err = oversizedInlineContextFailure(
			{
				current_input_file_enabled: true,
				current_input_file_min_bytes: 10,
				supports_authenticated_session: false,
			},
			"x".repeat(40),
			check,
		);
		assert.equal(err.code, "gemini_authenticated_session_required");
		assert.equal(err.status, 422);
		assert.equal(err.reason, "large_context");
		assert.equal(err.promptBytes, 11);
		assert.equal(err.promptBytesExact, false);
		assert.match(err.message, /at least 11 UTF-8 bytes > 10/);
	});
	test("decides context-file eligibility without requiring uploads", async () => {
		const cfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 10,
			current_input_file_name: "history.txt",
			supports_authenticated_session: true,
		};
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
		assert.equal(
			shouldUseContextFiles(cfg, "history", "latest", "x".repeat(40), check),
			true,
		);
		assert.equal(
			shouldUseContextFiles(cfg, "", "latest", "x".repeat(40), check),
			false,
		);
		assert.equal(
			shouldUseContextFiles(cfg, "history", "   ", "x".repeat(40), check),
			false,
		);
	});
	test("formats latest context-file prompt around the inline byte limit", async () => {
		const smallCfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 12,
			current_input_file_name: "conversation.txt",
			cookie: "SID=ok",
		};
		const largeCfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 120000,
			current_input_file_name: "conversation.txt",
			cookie: "SID=ok",
		};
		assert.equal(latestInputInlineLimit(smallCfg), 4000);
		assert.equal(latestInputInlineLimit(largeCfg), 16000);
		assert.equal(
			latestInputPromptForContextFile(smallCfg, "  short latest  "),
			"Latest user request:\nshort latest",
		);
		assert.equal(latestInputPromptForContextFile(smallCfg, "   "), "");
		const longPrompt = latestInputPromptForContextFile(
			smallCfg,
			"x".repeat(5000),
		);
		assert.match(
			longPrompt,
			/latest user request is at the end of `conversation\.txt`/,
		);
		assert.doesNotMatch(longPrompt, /x{100}/);
	});
	test("returns upload failure metadata when large context has no uploader", async () => {
		const cfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 10,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "SID=ok",
			supports_authenticated_session: true,
		};
		const check = contextFilePromptByteCheck(cfg, "x".repeat(40));
		const result = await prepareContextFiles(
			cfg,
			"prior conversation",
			null,
			"",
			"latest request",
			"x".repeat(40),
			undefined,
			check,
		);
		assert.equal(result.error.code, "large_context_file_upload_failed");
		assert.equal(result.error.promptBytes, 11);
		assert.equal(result.error.promptBytesExact, false);
		assert.equal(result.error.thresholdBytes, 10);
		assert.match(
			result.error.cause.message,
			/text file uploader is not configured/,
		);

		const direct = contextFileUploadFailure("tools", "short", "network down");
		assert.equal(direct.code, "large_context_file_upload_failed");
		assert.equal(direct.promptBytes, 5);
		assert.equal(direct.promptBytesExact, true);
		assert.equal(direct.cause, "network down");
	});
	test("refuses oversized inline fallback when history context upload fails", async () => {
		const cfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 10,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "SID=ok",
			supports_authenticated_session: true,
			log_requests: false,
		};
		const result = await prepareContextFilesWithUploader(
			cfg,
			"prior conversation",
			null,
			"",
			"latest request",
			"x".repeat(40),
			async () => {
				throw new Error("history upload broke");
			},
		);
		assert.equal(result.error.code, "large_context_file_upload_failed");
		assert.match(
			result.error.message,
			/failed to upload history context text file/,
		);
		assert.match(result.error.cause.message, /history upload broke/);
	});
	test("refuses oversized inline fallback when tools context upload fails", async () => {
		const cfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 10,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "SID=ok",
			supports_authenticated_session: true,
			log_requests: false,
		};
		const uploads = [];
		const result = await prepareContextFilesWithUploader(
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
		);
		assert.equal(uploads.length, 2);
		assert.equal(result.error.code, "large_context_file_upload_failed");
		assert.match(
			result.error.message,
			/failed to upload tools context text file/,
		);
		assert.match(result.error.cause.message, /tools upload broke/);
	});
});
