import assert from "./assertions.js";
import { baseConfig, chunks, collectSSEData, fakeProvider, fakeStreamProvider, mod, resolvedModel, streamError, withConsoleLog, withFetch } from "./helpers.js";

export const suiteName = "openai http";
export const cases = [
  ["normalizes Responses input without leaking unknown event payloads", async () => {
    const messages = mod.normalizeResponsesInputAsMessages({
      input: [
        { type: "input_text", text: "known text" },
        { type: "custom_event", text: "do not leak text", content: [{ type: "input_text", text: "do not leak content" }], metadata: { secret: "do not leak json" } },
        { custom: "do not leak object" },
      ],
    });
    assert.deepEqual(messages, [{ role: "user", content: "known text" }]);
    assert.deepEqual(mod.normalizeResponsesInputAsMessages({ input: { type: "custom_event", text: "do not leak root" } }), []);
  }],
  ["rejects invalid Responses model before provider generation", async () => {
    let generated = false;
    const provider = {
      async generateText() {
        generated = true;
        return "done";
      },
      streamText() {
        return chunks([]);
      },
      async resolveImages() {
        return { fileRefs: null, droppedNote: "" };
      },
      async uploadTextFile(_text, filename) {
        return { ref: `/uploaded/${filename}`, name: filename };
      },
    };
    const resp = await mod.handleResponses({
      model: "",
      input: "plain request",
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
    }, provider);
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.equal(body.error.code, "model_not_found");
    assert.equal(generated, false);
  }],
  ["rejects invalid OpenAI response format before provider generation", async () => {
    let generated = false;
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "return json" }],
      response_format: { type: "json_schema", json_schema: { name: "missing_schema" } },
    }, baseConfig(), fakeProvider({
      async generateText() {
        generated = true;
        return "{}";
      },
    }));
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.equal(body.error.code, "invalid_response_format");
    assert.equal(body.error.message, "response_format json_schema requires a schema object");
    assert.equal(generated, false);
  }],
  ["rejects empty OpenAI prompts before provider generation", async () => {
    let generated = false;
    const chat = await mod.handleChat({
      model: "gemini-3.5-flash",
      messages: [],
    }, baseConfig(), fakeProvider({
      async generateText() {
        generated = true;
        return "unexpected";
      },
    }));
    assert.equal(chat.status, 400);
    assert.equal((await chat.json()).error.message, "empty prompt");

    const responses = await mod.handleResponses({
      model: "gemini-3.5-flash",
      input: [],
    }, baseConfig(), fakeProvider({
      async generateText() {
        generated = true;
        return "unexpected";
      },
    }));
    assert.equal(responses.status, 400);
    assert.equal((await responses.json()).error.message, "empty input");
    assert.equal(generated, false);
  }],
  ["maps OpenAI context upload failures during prepare", async () => {
    let generated = false;
    const uploadErr = new Error("upload refused");
    uploadErr.status = 504;
    uploadErr.code = "context_upload_failed";
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "large prompt " + "x".repeat(80) }],
    }, baseConfig({
      current_input_file_enabled: true,
      current_input_file_min_bytes: 1,
      cookie: "SID=ok",
    }), fakeProvider({
      async uploadTextFile() {
        throw uploadErr;
      },
      async generateText() {
        generated = true;
        return "unexpected";
      },
    }));
    assert.equal(resp.status, 502);
    const body = await resp.json();
    assert.equal(body.error.code, "large_context_file_upload_failed");
    assert.match(body.error.message, /failed to upload history context text file/);
    assert.equal(generated, false);
  }],
  ["adds dropped image note when Responses image upload is unavailable", async () => {
    let generated = false;
    const prompts = [];
    const provider = {
      async generateText(input) {
        generated = true;
        prompts.push(input.prompt);
        return "done";
      },
      streamText() {
        return chunks([]);
      },
      async resolveImages() {
        return {
          fileRefs: null,
          droppedNote: "\n\n[Note: 1 image(s) were provided but ignored - image input requires a configured GEMINI_COOKIE.]",
        };
      },
      async uploadTextFile(_text, filename) {
        return { ref: `/uploaded/${filename}`, name: filename };
      },
    };
    const resp = await mod.handleResponses({
      model: "gemini-3.5-flash",
      input: [{ role: "user", content: [{ type: "input_text", text: "describe this" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] }],
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
    }, provider);
    assert.equal(resp.status, 200);
    assert.equal(generated, true);
    assert.match(prompts[0], /image\(s\) were provided but ignored/);
  }],
  ["adds DSML tool instructions for Responses tools", async () => {
    const prompts = [];
    const provider = {
      async generateText(input) {
        prompts.push(input.prompt);
        return "done";
      },
      streamText() {
        return chunks([]);
      },
      async resolveImages() {
        return { fileRefs: null, droppedNote: "" };
      },
      async uploadTextFile(_text, filename) {
        return { ref: `/uploaded/${filename}`, name: filename };
      },
    };
    const resp = await mod.handleResponses({
      model: "gemini-3.5-flash",
      input: "find docs",
      tools: [{
        type: "function",
        name: "Search",
        description: "Search docs",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      }],
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
    }, provider);
    assert.equal(resp.status, 200);
    assert.match(prompts[0], /Available tools/);
    assert.match(prompts[0], /<\|DSML\|tool_calls>/);
    assert.match(prompts[0], /"name": "Search"/);
    assert.match(prompts[0], /"query"/);
  }],
  ["adds DSML tool instructions for wrapped Responses tools", async () => {
    const prompts = [];
    const provider = {
      async generateText(input) {
        prompts.push(input.prompt);
        return "done";
      },
      streamText() {
        return chunks([]);
      },
      async resolveImages() {
        return { fileRefs: null, droppedNote: "" };
      },
      async uploadTextFile(_text, filename) {
        return { ref: `/uploaded/${filename}`, name: filename };
      },
    };
    const resp = await mod.handleResponses({
      model: "gemini-3.5-flash",
      input: "find docs",
      tools: {
        tools: [{
          type: "function",
          name: "WrappedSearch",
          description: "Search docs",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        }],
      },
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
    }, provider);
    assert.equal(resp.status, 200);
    assert.match(prompts[0], /Available tools/);
    assert.match(prompts[0], /<\|DSML\|tool_calls>/);
    assert.match(prompts[0], /"name": "WrappedSearch"/);
  }],
  ["moves large Responses tools into attached tools file", async () => {
    const prompts = [];
    const uploads = [];
    const provider = {
      async generateText(input) {
        prompts.push(input.prompt);
        return "done";
      },
      streamText() {
        return chunks([]);
      },
      async resolveImages() {
        return { fileRefs: null, droppedNote: "" };
      },
      async uploadTextFile(text, filename) {
        uploads.push({ text, filename });
        return { ref: `/uploaded/${filename}`, name: filename };
      },
    };
    const resp = await mod.handleResponses({
      model: "gemini-3.5-flash",
      input: "find docs " + "x".repeat(120),
      tools: [{
        type: "function",
        name: "Search",
        description: "Search docs",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      }],
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: true,
      current_input_file_min_bytes: 40,
      current_input_file_name: "message.txt",
      current_tools_file_name: "tools.txt",
      cookie: "SID=ok",
      log_requests: false,
    }, provider);
    assert.equal(resp.status, 200);
    assert.equal(uploads.length, 2);
    assert.doesNotMatch(prompts[0], /<\|DSML\|tool_calls>/);
    assert.match(prompts[0], /Context is attached/);
    assert.match(prompts[0], /tools\.txt/);
    assert.match(prompts[0], /All text above this sentence is system prompt content/);
    assert.doesNotMatch(prompts[0], /Gemini native hidden tool calls/);
    assert.doesNotMatch(prompts[0], /Available tools/);
    assert.doesNotMatch(prompts[0], /"query"/);
    assert.match(uploads[1].text, /Available tool descriptions/);
    assert.match(uploads[1].text, /Tool call format instructions/);
    assert.match(uploads[1].text, /<\|DSML\|tool_calls>/);
    assert.match(uploads[1].text, /Gemini native hidden tool calls/);
    assert.match(uploads[1].text, /"name": "Search"/);
    assert.match(uploads[1].text, /"query"/);
  }],
  ["omits tool instructions for plain Responses requests", async () => {
    const prompts = [];
    const provider = {
      async generateText(input) {
        prompts.push(input.prompt);
        return "done";
      },
      streamText() {
        return chunks([]);
      },
      async resolveImages() {
        return { fileRefs: null, droppedNote: "" };
      },
      async uploadTextFile(_text, filename) {
        return { ref: `/uploaded/${filename}`, name: filename };
      },
    };
    const resp = await mod.handleResponses({
      model: "gemini-3.5-flash",
      input: "plain request",
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
    }, provider);
    assert.equal(resp.status, 200);
    assert.doesNotMatch(prompts[0], /<\|DSML\|tool_calls>/);
    assert.doesNotMatch(prompts[0], /Available tools/);
  }],
  ["prevents unknown Responses input events from reaching prompt text", async () => {
    const prompts = [];
    const provider = {
      async generateText(input) {
        prompts.push(input.prompt);
        return "done";
      },
      streamText() {
        return chunks([]);
      },
      async resolveImages() {
        return { fileRefs: null, droppedNote: "" };
      },
      async uploadTextFile(_text, filename) {
        return { ref: `/uploaded/${filename}`, name: filename };
      },
    };
    const resp = await mod.handleResponses({
      model: "gemini-3.5-flash",
      input: [
        { type: "input_text", text: "visible request" },
        { type: "custom_event", text: "do not leak text", content: [{ type: "input_text", text: "do not leak content" }], metadata: { secret: "do not leak json" } },
      ],
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
    }, provider);
    assert.equal(resp.status, 200);
    assert.match(prompts[0], /visible request/);
    assert.doesNotMatch(prompts[0], /do not leak text/);
    assert.doesNotMatch(prompts[0], /do not leak content/);
    assert.doesNotMatch(prompts[0], /do not leak json/);
  }],
  ["returns OpenAI chat completions with text usage and stop finish", async () => {
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "say hi" }],
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
      structured_output_stream_mode: "reject",
    }, fakeProvider({
      async generateText(input) {
        assert.match(input.prompt, /say hi/);
        return "hello";
      },
    }));
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "hello");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.equal(body.usage.total_tokens >= body.usage.prompt_tokens, true);
  }],
  ["passes OpenAI referenced file ids from chat request fields to provider", async () => {
    let seenFileRefs = null;
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      ref_file_ids: ["file_top", "file_dup"],
      file_ids: ["file_dup", "file_list"],
      attachments: [
        { file_id: "file_attach", filename: "../attach.txt" },
        { type: "input_file", id: "file_typed", file_name: "typed.txt" },
        { file: { id: "file_nested", filename: "nested.txt" } },
      ],
      messages: [{
        role: "user",
        content: [
          { type: "input_text", text: "summarize files" },
          { type: "input_file", file_id: "file_content", filename: "content.txt" },
        ],
      }],
      input: [{ content: [{ type: "input_file", file_id: "file_input", filename: "input.txt" }] }],
    }, baseConfig(), fakeProvider({
      async generateText(input) {
        seenFileRefs = input.fileRefs;
        return "done";
      },
    }));
    assert.equal(resp.status, 200);
    assert.deepEqual(seenFileRefs, [
      "file_top",
      "file_dup",
      "file_list",
      { id: "file_attach", name: "attach.txt" },
      { id: "file_typed", name: "typed.txt" },
      { id: "file_nested", name: "nested.txt" },
      { id: "file_content", name: "content.txt" },
      { id: "file_input", name: "input.txt" },
    ]);
  }],
  ["passes OpenAI inline input_file uploads to provider without treating bytes as file ids", async () => {
    let seenFiles = null;
    let seenFileRefs = null;
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      ref_file_ids: ["file_existing"],
      messages: [{
        role: "user",
        content: [
          { type: "input_text", text: "review this code" },
          { type: "input_file", id: "part_1", filename: "../main.py", file_data: "data:text/x-python;base64,cHJpbnQoMSkK" },
        ],
      }],
    }, baseConfig(), fakeProvider({
      async resolveFiles(files) {
        seenFiles = files;
        return { fileRefs: [{ ref: "/uploaded/main-py", name: "main.py" }], droppedNote: "" };
      },
      async generateText(input) {
        seenFileRefs = input.fileRefs;
        return "done";
      },
    }));
    assert.equal(resp.status, 200);
    assert.deepEqual(seenFiles, [{ b64: "cHJpbnQoMSkK", mime: "text/x-python", filename: "main.py" }]);
    assert.deepEqual(seenFileRefs, [
      "file_existing",
      { ref: "/uploaded/main-py", name: "main.py" },
    ]);
  }],
  ["does not treat nested inline input_file file.id as an existing file ref", async () => {
    let seenFiles = null;
    let seenFileRefs = null;
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      messages: [{
        role: "user",
        content: [{
          type: "input_file",
          file: {
            id: "local_part",
            data: "aGVsbG8=",
            filename: "note.txt",
            mime_type: "text/plain",
          },
        }],
      }],
    }, baseConfig(), fakeProvider({
      async resolveFiles(files) {
        seenFiles = files;
        return { fileRefs: [{ ref: "/uploaded/note", name: "note.txt" }], droppedNote: "" };
      },
      async generateText(input) {
        seenFileRefs = input.fileRefs;
        return "done";
      },
    }));
    assert.equal(resp.status, 200);
    assert.deepEqual(seenFiles, [{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" }]);
    assert.deepEqual(seenFileRefs, [{ ref: "/uploaded/note", name: "note.txt" }]);
  }],
  ["passes top-level Responses input_file uploads to provider", async () => {
    let seenFiles = null;
    let seenFileRefs = null;
    const resp = await mod.handleResponses({
      model: "gemini-3.5-flash",
      input: [
        { type: "input_text", text: "review this note" },
        { type: "input_file", filename: "../note.txt", file_data: { data: "aGVsbG8=", mime_type: "text/plain" } },
      ],
    }, baseConfig(), fakeProvider({
      async resolveFiles(files) {
        seenFiles = files;
        return { fileRefs: [{ ref: "/uploaded/note", name: "note.txt" }], droppedNote: "" };
      },
      async generateText(input) {
        seenFileRefs = input.fileRefs;
        return "done";
      },
    }));
    assert.equal(resp.status, 200);
    assert.deepEqual(seenFiles, [{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" }]);
    assert.deepEqual(seenFileRefs, [{ ref: "/uploaded/note", name: "note.txt" }]);
  }],
  ["passes top-level OpenAI attachments inline uploads to provider", async () => {
    let seenFiles = null;
    let seenFileRefs = null;
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "review attachments" }],
      attachments: [
        { type: "input_file", id: "local_part", filename: "../top.txt", file_data: "dG9w", mime_type: "text/plain" },
        { type: "file", file_id: "file_existing", filename: "existing.txt" },
      ],
    }, baseConfig(), fakeProvider({
      async resolveFiles(files) {
        seenFiles = files;
        return { fileRefs: [{ ref: "/uploaded/top", name: "top.txt" }], droppedNote: "" };
      },
      async generateText(input) {
        seenFileRefs = input.fileRefs;
        return "done";
      },
    }));
    assert.equal(resp.status, 200);
    assert.deepEqual(seenFiles, [{ b64: "dG9w", mime: "text/plain", filename: "top.txt" }]);
    assert.deepEqual(seenFileRefs, [
      { id: "file_existing", name: "existing.txt" },
      { ref: "/uploaded/top", name: "top.txt" },
    ]);
  }],
  ["adds dropped generic file note and continues OpenAI chat generation", async () => {
    let seenPrompt = "";
    let seenFileRefs = "unset";
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: [{ type: "input_file", data: "aGVsbG8=", filename: "note.txt" }] }],
    }, baseConfig(), fakeProvider({
      async resolveFiles() {
        return { fileRefs: null, droppedNote: "\n\n[Note: 1 file(s) were provided but ignored - some file uploads failed.]" };
      },
      async generateText(input) {
        seenPrompt = input.prompt;
        seenFileRefs = input.fileRefs;
        return "continued";
      },
    }));
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.choices[0].message.content, "continued");
    assert.match(seenPrompt, /\[Note: 1 file\(s\) were provided but ignored - some file uploads failed\.\]/);
    assert.equal(seenFileRefs, null);
  }],
  ["returns OpenAI chat empty upstream warning with visible fallback text", async () => {
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "say something" }],
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
      structured_output_stream_mode: "reject",
    }, fakeProvider({
      async generateText() {
        return "";
      },
    }));
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.warning.code, "upstream_empty");
    assert.equal(body.choices[0].message.content, mod.EMPTY_UPSTREAM_MSG);
    assert.equal(body.choices[0].finish_reason, "stop");
  }],
  ["canonicalizes non-stream structured OpenAI chat JSON output", async () => {
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "return json" }],
      response_format: { type: "json_object" },
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
      structured_output_stream_mode: "reject",
    }, fakeProvider({
      async generateText(input) {
        assert.match(input.prompt, /STRUCTURED OUTPUT REQUIREMENT/);
        return "```json\n{\"ok\":true}\n```";
      },
    }));
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.choices[0].message.content, "{\"ok\":true}");
    assert.equal(body.choices[0].finish_reason, "stop");
  }],
  ["rejects invalid non-stream structured OpenAI chat JSON schema output", async () => {
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "return strict json" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "strict_result",
          schema: {
            type: "object",
            required: ["ok"],
            additionalProperties: false,
            properties: { ok: { type: "boolean" } },
          },
        },
      },
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
      structured_output_stream_mode: "reject",
    }, fakeProvider({
      async generateText(input) {
        assert.match(input.prompt, /Schema name: strict_result/);
        return "{\"ok\":true,\"extra\":1}";
      },
    }));
    assert.equal(resp.status, 502);
    const body = await resp.json();
    assert.equal(body.error.code, "structured_output_validation_failed");
    assert.match(body.error.message, /extra is not allowed/);
  }],
  ["maps non-stream OpenAI Chat upstream errors to OpenAI error format", async () => {
    const err = streamError("chat overloaded secret", "chat_overloaded");
    err.status = 503;
    const logs = [];
    const resp = await withConsoleLog((line) => logs.push(String(line)), () => mod.handleChat({
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "try once" }],
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: true,
      structured_output_stream_mode: "reject",
    }, fakeProvider({
      async generateText() {
        throw err;
      },
    })));
    assert.equal(resp.status, 503);
    const body = await resp.json();
    assert.equal(body.error.code, "chat_overloaded");
    assert.equal(body.error.type, "service_unavailable_error");
    assert.match(body.error.message, /upstream error: chat overloaded secret/);
    const failureLog = logs.find((line) => line.includes("openai chat generate failed"));
    assert.match(failureLog, /error=type=Error code=chat_overloaded status=503/);
    assert.doesNotMatch(failureLog, /chat overloaded secret/);
  }],
  ["maps non-stream OpenAI Chat upstream empty errors instead of returning fallback 200", async () => {
    const err = streamError("Gemini upstream HTTP 200 returned no parseable text (non-stream)", "upstream_empty_response");
    err.status = 502;
    err.upstreamStatus = 200;
    err.rawLength = 31;
    const logs = [];
    const resp = await withConsoleLog((line) => logs.push(String(line)), () => mod.handleChat({
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "try once" }],
    }, baseConfig({ log_requests: true }), fakeProvider({
      async generateText() {
        throw err;
      },
    })));
    assert.equal(resp.status, 502);
    const body = await resp.json();
    assert.equal(body.error.code, "upstream_empty_response");
    assert.equal(body.error.type, "api_error");
    assert.match(body.error.message, /upstream error: Gemini upstream HTTP 200 returned no parseable text/);
    const failureLog = logs.find((line) => line.includes("openai chat generate failed"));
    assert.match(failureLog, /error=type=Error code=upstream_empty_response status=502 upstreamStatus=200 rawLength=31/);
  }],
  ["rejects invalid non-stream structured OpenAI Responses JSON schema output", async () => {
    const resp = await mod.handleResponses({
      model: "gemini-3.5-flash",
      input: "return strict json",
      text: {
        format: {
          type: "json_schema",
          name: "strict_response",
          schema: {
            type: "object",
            required: ["ok"],
            additionalProperties: false,
            properties: { ok: { type: "boolean" } },
          },
        },
      },
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
      structured_output_stream_mode: "reject",
    }, fakeProvider({
      async generateText(input) {
        assert.match(input.prompt, /Schema name: strict_response/);
        return "{\"ok\":true,\"extra\":1}";
      },
    }));
    assert.equal(resp.status, 502);
    const body = await resp.json();
    assert.equal(body.error.code, "structured_output_validation_failed");
    assert.match(body.error.message, /extra is not allowed/);
  }],
  ["maps non-stream OpenAI Responses upstream errors to OpenAI error format", async () => {
    const err = streamError("responses overloaded secret", "upstream_overloaded");
    err.status = 503;
    const logs = [];
    const resp = await withConsoleLog((line) => logs.push(String(line)), () => mod.handleResponses({
      model: "gemini-3.5-flash",
      input: "try once",
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: true,
    }, fakeProvider({
      async generateText() {
        throw err;
      },
    })));
    assert.equal(resp.status, 503);
    const body = await resp.json();
    assert.equal(body.error.code, "upstream_overloaded");
    assert.equal(body.error.type, "service_unavailable_error");
    assert.match(body.error.message, /upstream error: responses overloaded secret/);
    const failureLog = logs.find((line) => line.includes("openai responses generate failed"));
    assert.match(failureLog, /error=type=Error code=upstream_overloaded status=503/);
    assert.doesNotMatch(failureLog, /responses overloaded secret/);
  }],
  ["formats OpenAI error envelopes usage chunks and response output edges", async () => {
    assert.equal(mod.openAIErrorType(400), "invalid_request_error");
    assert.equal(mod.openAIErrorType(401), "authentication_error");
    assert.equal(mod.openAIErrorType(403), "permission_error");
    assert.equal(mod.openAIErrorType(429), "rate_limit_error");
    assert.equal(mod.openAIErrorType(503), "service_unavailable_error");
    assert.equal(mod.openAIErrorType(500), "api_error");
    assert.equal(mod.openAIErrorType(418), "invalid_request_error");

    const forbidden = mod.openAIErrorResponse("blocked", 403, "policy_blocked");
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers.get("content-type"), "application/json");
    assert.deepEqual(await forbidden.json(), {
      error: {
        message: "blocked",
        type: "permission_error",
        code: "policy_blocked",
        param: null,
      },
    });
    const defaultErr = await mod.openAIErrorResponse("bad request").json();
    assert.equal(defaultErr.error.type, "invalid_request_error");
    assert.equal(defaultErr.error.code, null);

    const upstream = streamError("gateway down", "upstream_down");
    const upstreamResp = mod.openAIUpstreamErrorResponse(upstream);
    assert.equal(upstreamResp.status, 502);
    const upstreamBody = await upstreamResp.json();
    assert.equal(upstreamBody.error.type, "api_error");
    assert.equal(upstreamBody.error.code, "upstream_down");
    assert.match(upstreamBody.error.message, /upstream error: gateway down/);

    const usageWrites = [];
    mod.writeOpenAIChatUsageTokenChunk((chunk) => usageWrites.push(chunk), "chatcmpl_usage", 0, -2, "3");
    const usageFrame = collectSSEData(usageWrites)[0];
    assert.equal(usageFrame.id, "chatcmpl_usage");
    assert.deepEqual(usageFrame.choices, []);
    assert.deepEqual(usageFrame.usage, {
      prompt_tokens: 0,
      completion_tokens: 3,
      total_tokens: 3,
    });

    const errorWrites = [];
    mod.writeOpenAIChatStreamError((chunk) => errorWrites.push(chunk), "chatcmpl_error", "gemini-3.5-flash", upstream);
    const errorFrames = collectSSEData(errorWrites);
    assert.match(errorFrames[0].choices[0].delta.content, /upstream error: gateway down \[upstream_down\]/);
    assert.equal(errorFrames[1].choices[0].finish_reason, "stop");
    assert.equal(errorFrames[2], "[DONE]");

    const responsesUsage = mod.openAIResponsesUsage(-5, "abcd");
    assert.equal(responsesUsage.input_tokens, 0);
    assert.equal(responsesUsage.output_tokens > 0, true);
    assert.equal(responsesUsage.total_tokens, responsesUsage.output_tokens);

    const onlyValidTool = mod.buildResponsesOutput("", [
      "skip",
      { id: "call_bad", function: { name: "MissingArguments" } },
      { id: "call_1", function: { name: "Lookup", arguments: "{\"id\":\"1\"}" } },
    ], "msg_skip");
    assert.equal(onlyValidTool.length, 1);
    assert.equal(onlyValidTool[0].type, "function_call");
    assert.equal(onlyValidTool[0].call_id, "call_1");

    const emptyArrayOutput = mod.buildResponsesOutput("", [], "msg_empty");
    assert.equal(emptyArrayOutput[0].type, "message");
    assert.equal(emptyArrayOutput[0].content[0].text, "");
    const nonArrayOutput = mod.buildResponsesOutput("", null, "msg_null");
    assert.equal(nonArrayOutput[0].type, "message");
  }],
  ["rejects missing OpenAI Responses request objects", async () => {
    const resp = await mod.handleResponses(undefined, baseConfig(), fakeProvider());
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.equal(body.error.message, "request body must be a JSON object");
  }],
  ["returns OpenAI Responses empty upstream warning with fallback message", async () => {
    const resp = await mod.handleResponses({
      model: "gemini-3.5-flash",
      input: "say something",
    }, baseConfig(), fakeProvider({
      async generateText() {
        return "";
      },
    }));
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.warning.code, "upstream_empty");
    assert.equal(body.output[0].content[0].text, mod.EMPTY_UPSTREAM_MSG);
  }],
  ["rejects unsupported streaming structured OpenAI Responses", async () => {
    let generated = false;
    const resp = await mod.handleResponses({
      model: "gemini-3.5-flash",
      stream: true,
      input: "json please",
      text: { format: { type: "json_object" } },
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
      structured_output_stream_mode: "reject",
    }, fakeProvider({
      async generateText() {
        generated = true;
        return "{}";
      },
    }));
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.equal(body.error.code, "unsupported_response_format_stream");
    assert.equal(generated, false);
  }],
  ["streams OpenAI Responses plain output through handler path", async () => {
    const resp = await mod.handleResponses({
      model: "gemini-3.5-flash",
      stream: true,
      input: "say hello",
    }, baseConfig(), fakeStreamProvider(["he", "llo"]));
    assert.equal(resp.status, 200);
    const frames = collectSSEData([await resp.text()]);
    assert.equal(frames[0].type, "response.created");
    assert.equal(frames.filter((frame) => frame.type === "response.output_text.delta").map((frame) => frame.delta).join(""), "hello");
    const completed = frames.find((frame) => frame.type === "response.completed");
    assert.equal(completed.response.output[0].content[0].text, "hello");
    assert.equal(completed.response.status, "completed");
  }],
  ["streams OpenAI Responses tool-choice none violations through handler path", async () => {
    const resp = await mod.handleResponses({
      model: "gemini-3.5-flash",
      stream: true,
      input: "do not call tools",
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
      tool_choice: "none",
    }, baseConfig(), fakeStreamProvider(["<tool_calls><invoke name=\"Read\"><parameter name=\"path\">README.md</parameter></invoke></tool_calls>"]));
    assert.equal(resp.status, 200);
    const frames = collectSSEData([await resp.text()]);
    const failed = frames.find((frame) => frame.type === "response.failed");
    assert.equal(failed.response.status, "failed");
    assert.equal(failed.response.error.code, "tool_choice_violation");
    assert.match(failed.response.error.message, /does not allow tool\(s\): Read/);
  }],
  ["streams OpenAI chat tool-choice none violations through handler path", async () => {
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      stream: true,
      messages: [{ role: "user", content: "do not call tools" }],
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
      tool_choice: "none",
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
      structured_output_stream_mode: "reject",
    }, fakeStreamProvider(["<tool_calls><invoke name=\"Read\"><parameter name=\"path\">README.md</parameter></invoke></tool_calls>"]));
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /tool_choice does not allow tool\(s\): Read/);
    assert.match(body, /data: \[DONE\]/);
  }],
  ["rejects unsupported streaming structured OpenAI chat responses", async () => {
    let generated = false;
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      stream: true,
      messages: [{ role: "user", content: "json please" }],
      response_format: { type: "json_object" },
    }, {
      default_model: "gemini-3.5-flash",
      current_input_file_enabled: false,
      current_input_file_min_bytes: 1000000,
      log_requests: false,
      structured_output_stream_mode: "reject",
    }, fakeProvider({
      async generateText() {
        generated = true;
        return "{}";
      },
    }));
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.equal(body.error.code, "unsupported_response_format_stream");
    assert.equal(generated, false);
  }],
  ["streams OpenAI chat warning usage and DONE after partial output", async () => {
    const writes = [];
    const logs = [];
    await withConsoleLog((line) => logs.push(String(line)), () => mod.streamOpenAIChatPlain((chunk) => writes.push(chunk), baseConfig({ log_requests: true }), {
      provider: fakeProvider({
        streamText() {
          return chunks(["hello"], 0);
        },
      }),
      id: "chatcmpl_test",
      model: "gemini-3.5-flash",
      prompt: "say hello",
      rm: resolvedModel(),
      fileRefs: null,
      includeUsage: true,
      promptTokens: 3,
      signal: new AbortController().signal,
    }));
    const frames = collectSSEData(writes);
    assert.equal(frames[0].choices[0].delta.role, "assistant");
    assert.equal(frames.some((frame) => frame.warning && frame.warning.code === "stream_interrupted"), true);
    assert.equal(frames.some((frame) => frame.choices && String(frame.choices[0].delta.content || "").includes("stream interrupted after partial output")), true);
    assert.equal(frames.some((frame) => Array.isArray(frame.choices) && frame.choices.length === 0 && frame.usage.total_tokens >= 3), true);
    assert.equal(frames[frames.length - 1], "[DONE]");
    const warningLog = logs.find((line) => line.includes("openai chat stream interrupted after partial output"));
    assert.match(warningLog, /error=type=Error/);
    assert.doesNotMatch(warningLog, /stream broke/);
  }],
  ["streams OpenAI chat upstream error text before any output", async () => {
    const writes = [];
    const logs = [];
    await withConsoleLog((line) => logs.push(String(line)), () => mod.streamOpenAIChatPlain((chunk) => writes.push(chunk), baseConfig({ log_requests: true }), {
      provider: fakeProvider({
        streamText() {
          throw streamError("upstream down secret", "upstream_down");
        },
      }),
      id: "chatcmpl_error",
      model: "gemini-3.5-flash",
      prompt: "fail",
      rm: resolvedModel(),
      fileRefs: null,
      includeUsage: false,
      promptTokens: 1,
      signal: new AbortController().signal,
    }));
    const frames = collectSSEData(writes);
    assert.equal(frames.some((frame) => frame.choices && String(frame.choices[0].delta.content || "").includes("upstream error: upstream down secret")), true);
    assert.equal(frames.some((frame) => frame.choices && frame.choices[0].finish_reason === "stop"), true);
    assert.equal(frames[frames.length - 1], "[DONE]");
    const failureLog = logs.find((line) => line.includes("openai chat stream failed before output"));
    assert.match(failureLog, /error=type=Error code=upstream_down/);
    assert.doesNotMatch(failureLog, /upstream down secret/);
  }],
  ["streams OpenAI chat plain output through handler path with usage", async () => {
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "say hello" }],
    }, baseConfig(), fakeStreamProvider(["he", "llo"]));
    assert.equal(resp.status, 200);
    const frames = collectSSEData([await resp.text()]);
    assert.equal(frames[0].choices[0].delta.role, "assistant");
    const text = frames
      .filter((frame) => frame.choices && frame.choices[0] && frame.choices[0].delta && frame.choices[0].delta.content)
      .map((frame) => frame.choices[0].delta.content)
      .join("");
    assert.equal(text, "hello");
    assert.equal(frames.some((frame) => Array.isArray(frame.choices) && frame.choices.length === 0 && frame.usage.total_tokens >= frame.usage.prompt_tokens), true);
    assert.equal(frames[frames.length - 1], "[DONE]");
  }],
  ["streams OpenAI chat empty upstream fallback through handler path", async () => {
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      stream: true,
      messages: [{ role: "user", content: "say something" }],
    }, baseConfig(), fakeStreamProvider([]));
    assert.equal(resp.status, 200);
    const frames = collectSSEData([await resp.text()]);
    assert.equal(frames.some((frame) => frame.choices && frame.choices[0].delta.content === mod.EMPTY_UPSTREAM_MSG), true);
    assert.equal(frames.some((frame) => frame.choices && frame.choices[0].finish_reason === "stop"), true);
    assert.equal(frames[frames.length - 1], "[DONE]");
  }],
  ["streams OpenAI chat upstream errors through handler path", async () => {
    const resp = await mod.handleChat({
      model: "gemini-3.5-flash",
      stream: true,
      messages: [{ role: "user", content: "fail stream" }],
    }, baseConfig(), fakeProvider({
      streamText() {
        throw streamError("handler upstream down", "handler_down");
      },
    }));
    assert.equal(resp.status, 200);
    const frames = collectSSEData([await resp.text()]);
    assert.equal(frames.some((frame) => frame.choices && String(frame.choices[0].delta.content || "").includes("upstream error: handler upstream down [handler_down]")), true);
    assert.equal(frames.some((frame) => frame.choices && frame.choices[0].finish_reason === "stop"), true);
    assert.equal(frames[frames.length - 1], "[DONE]");
  }],
  ["streams OpenAI chat tool call deltas and usage", async () => {
    const writes = [];
    await mod.streamOpenAIChatWithToolSieve((chunk) => writes.push(chunk), baseConfig(), {
      provider: fakeStreamProvider(["<tool_calls><invoke name=\"Read\"><parameter name=\"path\">README.md</parameter></invoke></tool_calls>"]),
      id: "chatcmpl_tool",
      model: "gemini-3.5-flash",
      prompt: "read",
      rm: resolvedModel(),
      fileRefs: null,
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
      toolPolicy: null,
      includeUsage: true,
      promptTokens: 2,
      signal: new AbortController().signal,
    });
    const frames = collectSSEData(writes);
    const toolFrame = frames.find((frame) => frame.choices && frame.choices[0].delta.tool_calls);
    assert.equal(toolFrame.choices[0].finish_reason, "tool_calls");
    assert.equal(toolFrame.choices[0].delta.tool_calls[0].function.name, "Read");
    assert.equal(frames.some((frame) => Array.isArray(frame.choices) && frame.choices.length === 0 && frame.usage.total_tokens >= 2), true);
    assert.equal(frames[frames.length - 1], "[DONE]");
  }],
  ["streams OpenAI chat warning when tool call stream interrupts after a parsed call", async () => {
    const writes = [];
    await mod.streamOpenAIChatWithToolSieve((chunk) => writes.push(chunk), baseConfig(), {
      provider: fakeProvider({
        streamText() {
          return chunks(["<tool_calls><invoke name=\"Read\"><parameter name=\"path\">README.md</parameter></invoke></tool_calls>"], 0);
        },
      }),
      id: "chatcmpl_tool_warning",
      model: "gemini-3.5-flash",
      prompt: "read",
      rm: resolvedModel(),
      fileRefs: null,
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
      toolPolicy: null,
      includeUsage: false,
      promptTokens: 2,
      signal: new AbortController().signal,
    });
    const frames = collectSSEData(writes);
    assert.equal(frames.some((frame) => frame.warning && frame.warning.code === "stream_interrupted"), true);
    const toolFrame = frames.find((frame) => frame.choices && frame.choices[0].delta.tool_calls);
    assert.equal(toolFrame.choices[0].finish_reason, "tool_calls");
    assert.equal(toolFrame.choices[0].delta.tool_calls[0].function.name, "Read");
    assert.equal(frames[frames.length - 1], "[DONE]");
  }],
  ["streams OpenAI chat empty fallback when tool sieve produces no output", async () => {
    const writes = [];
    await mod.streamOpenAIChatWithToolSieve((chunk) => writes.push(chunk), baseConfig(), {
      provider: fakeStreamProvider([]),
      id: "chatcmpl_tool_empty",
      model: "gemini-3.5-flash",
      prompt: "read",
      rm: resolvedModel(),
      fileRefs: null,
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
      toolPolicy: null,
      includeUsage: false,
      promptTokens: 2,
      signal: new AbortController().signal,
    });
    const frames = collectSSEData(writes);
    assert.equal(frames.some((frame) => frame.choices && frame.choices[0].delta.content === mod.EMPTY_UPSTREAM_MSG), true);
    assert.equal(frames.some((frame) => frame.choices && frame.choices[0].finish_reason === "stop"), true);
    assert.equal(frames[frames.length - 1], "[DONE]");
  }],
  ["streams OpenAI chat warning when tool sieve text stream interrupts", async () => {
    const writes = [];
    const logs = [];
    await withConsoleLog((line) => logs.push(String(line)), () => mod.streamOpenAIChatWithToolSieve((chunk) => writes.push(chunk), baseConfig({ log_requests: true }), {
      provider: fakeProvider({
        streamText() {
          return chunks(["partial answer"], 0);
        },
      }),
      id: "chatcmpl_tool_partial",
      model: "gemini-3.5-flash",
      prompt: "answer",
      rm: resolvedModel(),
      fileRefs: null,
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
      toolPolicy: null,
      includeUsage: false,
      promptTokens: 2,
      signal: new AbortController().signal,
    }));
    const frames = collectSSEData(writes);
    assert.equal(frames.some((frame) => frame.warning && frame.warning.code === "stream_interrupted"), true);
    assert.equal(frames.some((frame) => frame.choices && String(frame.choices[0].delta.content || "").includes("stream interrupted after partial output")), true);
    assert.equal(frames.some((frame) => frame.choices && frame.choices[0].finish_reason === "stop"), true);
    assert.equal(frames[frames.length - 1], "[DONE]");
    const warningLog = logs.find((line) => line.includes("openai chat stream interrupted after partial output"));
    assert.match(warningLog, /error=type=Error/);
    assert.doesNotMatch(warningLog, /stream broke/);
  }],
  ["streams Responses warning after partial plain output", async () => {
    const writes = [];
    const logs = [];
    await withConsoleLog((line) => logs.push(String(line)), () => mod.streamResponsesWithToolSieve((chunk) => writes.push(chunk), baseConfig({ log_requests: true }), {
      provider: fakeProvider({
        streamText() {
          return chunks(["partial"], 0);
        },
      }),
      rid: "resp_partial",
      rm: resolvedModel(),
      prompt: "partial",
      fileRefs: null,
      tools: null,
      toolPolicy: null,
      promptTokens: 3,
      signal: new AbortController().signal,
    }));
    const frames = collectSSEData(writes);
    assert.equal(frames.some((frame) => frame.type === "response.warning" && frame.warning.code === "stream_interrupted"), true);
    assert.equal(frames.some((frame) => frame.type === "response.output_text.delta" && String(frame.delta || "").includes("stream interrupted after partial output")), true);
    const completed = frames.find((frame) => frame.type === "response.completed");
    assert.equal(completed.response.status, "completed");
    assert.equal(completed.response.usage.input_tokens, 3);
    const warningLog = logs.find((line) => line.includes("openai responses stream interrupted after partial output"));
    assert.match(warningLog, /error=type=Error/);
    assert.doesNotMatch(warningLog, /stream broke/);
  }],
  ["streams Responses function call output without message text", async () => {
    const writes = [];
    await mod.streamResponsesWithToolSieve((chunk) => writes.push(chunk), baseConfig(), {
      provider: fakeStreamProvider(["<tool_calls><invoke name=\"Read\"><parameter name=\"path\">README.md</parameter></invoke></tool_calls>"]),
      rid: "resp_tool",
      rm: resolvedModel(),
      prompt: "read",
      fileRefs: null,
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
      toolPolicy: null,
      promptTokens: 2,
      signal: new AbortController().signal,
    });
    const frames = collectSSEData(writes);
    const added = frames.find((frame) => frame.type === "response.output_item.added" && frame.item.type === "function_call");
    assert.equal(added.item.name, "Read");
    const argsDone = frames.find((frame) => frame.type === "response.function_call_arguments.done");
    assert.equal(argsDone.name, "Read");
    assert.match(argsDone.arguments, /README\.md/);
    const completed = frames.find((frame) => frame.type === "response.completed");
    assert.equal(completed.response.output.some((item) => item.type === "function_call" && item.name === "Read"), true);
  }],
  ["streams Responses failure when tool stream errors before output", async () => {
    const writes = [];
    const logs = [];
    await withConsoleLog((line) => logs.push(String(line)), () => mod.streamResponsesWithToolSieve((chunk) => writes.push(chunk), baseConfig({ log_requests: true }), {
      provider: fakeProvider({
        streamText() {
          throw streamError("upstream down secret", "upstream_down");
        },
      }),
      rid: "resp_tool_error",
      rm: resolvedModel(),
      prompt: "read",
      fileRefs: null,
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
      toolPolicy: null,
      promptTokens: 2,
      signal: new AbortController().signal,
    }));
    const frames = collectSSEData(writes);
    const failed = frames.find((frame) => frame.type === "response.failed");
    assert.equal(failed.response.status, "failed");
    assert.equal(failed.response.error.code, "upstream_down");
    assert.match(failed.response.error.message, /upstream error: upstream down secret/);
    const failureLog = logs.find((line) => line.includes("openai responses stream failed before output"));
    assert.match(failureLog, /error=type=Error code=upstream_down/);
    assert.doesNotMatch(failureLog, /upstream down secret/);
  }],
  ["streams Responses warning when tool stream errors after a parsed call", async () => {
    const writes = [];
    const logs = [];
    await withConsoleLog((line) => logs.push(String(line)), () => mod.streamResponsesWithToolSieve((chunk) => writes.push(chunk), baseConfig({ log_requests: true }), {
      provider: fakeProvider({
        streamText() {
          return chunks(["<tool_calls><invoke name=\"Read\"><parameter name=\"path\">README.md</parameter></invoke></tool_calls>"], 0);
        },
      }),
      rid: "resp_tool_warning",
      rm: resolvedModel(),
      prompt: "read",
      fileRefs: null,
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
      toolPolicy: null,
      promptTokens: 2,
      signal: new AbortController().signal,
    }));
    const frames = collectSSEData(writes);
    assert.equal(frames.some((frame) => frame.type === "response.warning" && frame.warning.code === "stream_interrupted"), true);
    assert.equal(frames.some((frame) => frame.type === "response.output_text.delta" && String(frame.delta || "").includes("stream interrupted after partial output")), true);
    assert.equal(frames.some((frame) => frame.type === "response.function_call_arguments.done" && frame.name === "Read"), true);
    const warningLog = logs.find((line) => line.includes("openai responses stream interrupted after partial output"));
    assert.match(warningLog, /error=type=Error/);
    assert.doesNotMatch(warningLog, /stream broke/);
  }],
  ["streams Responses empty upstream fallback text", async () => {
    const writes = [];
    await mod.streamResponsesWithToolSieve((chunk) => writes.push(chunk), baseConfig(), {
      provider: fakeStreamProvider([]),
      rid: "resp_empty",
      rm: resolvedModel(),
      prompt: "empty",
      fileRefs: null,
      tools: null,
      toolPolicy: null,
      promptTokens: 1,
      signal: new AbortController().signal,
    });
    const frames = collectSSEData(writes);
    assert.equal(frames.some((frame) => frame.type === "response.output_text.delta" && frame.delta === mod.EMPTY_UPSTREAM_MSG), true);
    const completed = frames.find((frame) => frame.type === "response.completed");
    assert.equal(completed.response.output[0].content[0].text, mod.EMPTY_UPSTREAM_MSG);
  }],
];
