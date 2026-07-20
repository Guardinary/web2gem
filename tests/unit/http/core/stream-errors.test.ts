import { describe, test } from "vitest";
import {
	streamErrorText,
	streamInterruptedWarningText,
	streamWarningObject,
	writeStreamWarningEvent,
} from "../../../../src/http/core/stream-errors";
import type { ErrorWithMetadata } from "../../../../src/shared/types";
import { assert } from "../../assertions.js";

describe("stream error presentation", () => {
	test("formats stream warning events with upstream code metadata", async () => {
		const err: ErrorWithMetadata = new Error("socket reset");
		err.code = "socket_reset";
		const warning = streamWarningObject(err, "partial output kept");
		assert.deepEqual(warning, {
			code: "socket_reset",
			message: "partial output kept",
		});
		assert.match(
			streamErrorText(err),
			/upstream error: socket reset \[socket_reset\]/,
		);
		assert.match(
			streamInterruptedWarningText(err),
			/stream interrupted after partial output: socket reset/,
		);

		const writes: string[] = [];
		writeStreamWarningEvent(
			(chunk) => {
				writes.push(chunk);
				return Promise.resolve();
			},
			err,
			"partial output kept",
		);
		assert.match(writes.join(""), /event: warning/);
		assert.match(writes.join(""), /"code":"socket_reset"/);
	});
});
