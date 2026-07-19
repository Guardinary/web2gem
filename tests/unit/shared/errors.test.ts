import { describe, test } from "vitest";
import {
	canFallbackAfterSocketError,
	errorLogSummary,
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorStatus,
} from "../../../src/shared/errors";
import type { ErrorWithMetadata } from "../../../src/shared/types";
import { assert } from "../assertions.js";

describe("shared upstream errors", () => {
	test("summarizes upstream errors and fallback eligibility", () => {
		const err: ErrorWithMetadata = new Error("bad gateway");
		err.code = "upstream_bad_gateway";
		err.status = 502;
		err.upstreamStatus = 503;
		assert.equal(upstreamErrorMessage(err), "bad gateway");
		assert.equal(upstreamErrorCode(err), "upstream_bad_gateway");
		assert.equal(upstreamErrorStatus(err), 502);
		assert.equal(upstreamErrorStatus({ status: 399 }), undefined);
		assert.match(errorLogSummary(err), /type=Error/);
		assert.match(errorLogSummary(err), /code=upstream_bad_gateway/);
		assert.match(errorLogSummary(err), /status=502/);
		assert.match(errorLogSummary(err), /upstreamStatus=503/);
		err.upstreamStatus = 200;
		err.rawLength = 37;
		assert.match(errorLogSummary(err), /upstreamStatus=200/);
		assert.match(errorLogSummary(err), /rawLength=37/);
		assert.match(errorLogSummary("plain failure"), /type=string/);
		assert.equal(
			canFallbackAfterSocketError("POST", new Error("socket closed")),
			true,
		);
		assert.equal(
			canFallbackAfterSocketError("POST", { upstreamStatus: 502 }),
			false,
		);
	});
});
