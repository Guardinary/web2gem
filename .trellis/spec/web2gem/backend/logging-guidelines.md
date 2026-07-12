# Logging Guidelines

## Runtime Logging

Use `log` and `logStage` from `src/shared/logging.ts` instead of raw `console` calls in feature code. Both respect `cfg.log_requests`; do not add duplicate logging aliases.

Existing low-level transport code may log socket fallback details directly, but new logs should prefer the shared helpers unless there is a runtime-bootstrap reason not to.

## Log Content

Logs may include route, status, retry, and upstream transport metadata. Do not log request bodies, cookies, API keys, SAPISID values, uploaded file content, or full prompts.

Do not log upstream response snippets or arbitrary `Error` strings from content-sensitive paths such as image upload and context-file upload. Use `errorLogSummary(error)` when the error may contain provider response text, user filenames, file contents, or request-derived data.

High-frequency success paths should stay out of runtime logs unless they are aggregated through `logStage`. For example, socket upstream success for every request is too noisy; socket fallback/failure is useful.

## Stage Telemetry

Use `logStage(cfg, stage, fields)` for opt-in performance telemetry under `LOG_REQUESTS`. Stage logs may include elapsed milliseconds, route path, model id, status/code, body byte counts, prompt character/token counts, context-file booleans, and file-reference counts.

`handleApplicationRequest` owns one opaque `x-request-id` per request and emits exactly one `request_complete` stage record when logging is enabled. The record includes request ID, method, path, response status, and elapsed milliseconds.

Do not include request content, prompt text, latest user input text, uploaded file text, cookies, API keys, SAPISID values, or authorization headers in stage fields.

When a stage field requires timing, string scans, byte/token counts, array/object construction, or any other non-trivial work, gate that work at the call site with `cfg.log_requests`. Do not rely on `logStage` alone to make the caller-side work free, because arguments are evaluated before `logStage` can return.

Good:

```typescript
const logRequests = !!cfg.log_requests;
const start = logRequests ? nowMs() : 0;
// hot-path work
if (logRequests) {
  logStage(cfg, "stage_name", {
    ms: elapsedMs(start),
    promptBytes: promptByteLength(prompt),
  });
}
```

Bad:

```typescript
const start = nowMs();
// hot-path work
logStage(cfg, "stage_name", {
  ms: elapsedMs(start),
  promptBytes: promptByteLength(prompt),
});
```
