import assert from "./assertions.js";
import { chunks, fakeProvider, fakeStreamProvider, mod, withConsoleLog, withFetch, withPatchedGlobal } from "./helpers.js";

export const suiteName = "uploads";
export const cases = [
  ["reports dropped image note when no Gemini cookie is configured", async () => {
    const result = await mod.resolveImages({
      cookie: "",
      log_requests: false,
    }, [{ b64: "AAAA", mime: "image/png" }]);
    assert.equal(result.fileRefs, null);
    assert.match(result.droppedNote, /image input requires a configured GEMINI_COOKIE/);
  }],
  ["returns generic file empty input without refreshing stale cookies", async () => {
    mod.resetActiveGeminiCookieForTest();
    const cfg = {
      gemini_origin: "https://gemini.example",
      cookie: "__Secure-1PSID=psid; SAPISID=sapi",
      sapisid: "sapi",
      request_timeout_sec: 180,
      upstream_socket: false,
      log_requests: false,
      generic_file_upload_max_bytes: 1024,
    };
    const originalNow = Date.now;
    Date.now = () => 0;
    try {
      mod.configWithActiveGeminiCookie(cfg);
      Date.now = () => 11 * 60 * 1000;
      await withFetch(async (url) => {
        throw new Error(`unexpected fetch ${url}`);
      }, async () => {
        const result = await mod.resolveFiles(cfg, []);
        assert.deepEqual(result, { fileRefs: null, droppedNote: "" });
      });
    } finally {
      Date.now = originalNow;
      mod.resetActiveGeminiCookieForTest();
    }
  }],
  ["reports missing base64 decoder when no native or atob decoder exists", async () => {
    const original = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    Object.defineProperty(Uint8Array, "fromBase64", { value: undefined, configurable: true, writable: true });
    try {
      await withPatchedGlobal("atob", undefined, async () => {
        await assert.rejects(() => mod.base64ToBytes("AAAA"), /base64 decoder is not available/);
      });
    } finally {
      if (original) Object.defineProperty(Uint8Array, "fromBase64", original);
      else delete Uint8Array.fromBase64;
    }
  }],
  ["uploads a single image through the direct uploadImage helper", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const requests = [];
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      requests.push({ href, init });
      if (href === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-direct","Ylro7b":"pctx-direct"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["Push-ID"], "push-direct");
        assert.equal(init.headers["X-Client-Pctx"], "pctx-direct");
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "image/jpeg");
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Length"], "2");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/direct-image" } });
      }
      if (href === "https://upload.example/direct-image") {
        assert.equal(init.body.byteLength, 2);
        return new Response("/uploaded/direct-image-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const ref = await mod.uploadImage({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, new Uint8Array([1, 2]), "image/jpeg");
      assert.equal(ref, "/uploaded/direct-image-ref");
    });
    assert.deepEqual(requests.map((request) => request.href), [
      "https://gemini.example/app",
      "https://content-push.googleapis.com/upload/",
      "https://upload.example/direct-image",
    ]);
  }],
  ["uploads images through Scotty and returns sanitized filenames", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const requests = [];
    await withFetch(async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url) === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-1","Ylro7b":"pctx-1","SNlM0e":"at-1"}', { status: 200 });
      }
      if (String(url) === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["Push-ID"], "push-1");
        assert.equal(init.headers["X-Client-Pctx"], "pctx-1");
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "image/png");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/finalize" } });
      }
      if (String(url) === "https://upload.example/finalize") {
        assert.equal(init.method, "POST");
        assert.equal(init.headers["X-Goog-Upload-Command"], "upload, finalize");
        return new Response("/uploaded/image-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveImages({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, [{ b64: "aGVsbG8=", mime: "image/png", filename: "../unsafe name.png" }]);
      assert.deepEqual(result.fileRefs, [{ ref: "/uploaded/image-ref", name: "unsafe name.png" }]);
      assert.equal(result.droppedNote, "");
    });
    assert.equal(requests.length, 3);
  }],
  ["uploads multiple images in parallel while preserving order", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    let startCount = 0;
    const finalizes = [];
    await withFetch(async (url) => {
      const href = String(url);
      if (href === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-1","Ylro7b":"pctx-1"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        const id = startCount;
        startCount += 1;
        return new Response("", { status: 200, headers: { "x-goog-upload-url": `https://upload.example/finalize/${id}` } });
      }
      if (href.startsWith("https://upload.example/finalize/")) {
        const id = href.split("/").pop();
        const gate = deferred();
        finalizes.push({ id, gate });
        if (finalizes.length === 3) {
          for (const item of finalizes) item.gate.resolve();
        }
        await gate.promise;
        return new Response(`/uploaded/image-${href.split("/").pop()}`, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveImages({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, [
        { b64: "YQ==", mime: "image/png", filename: "a.png" },
        { b64: "Yg==", mime: "image/png", filename: "b.png" },
        { b64: "Yw==", mime: "image/png", filename: "c.png" },
      ]);
      assert.deepEqual(result.fileRefs, [
        { ref: "/uploaded/image-0", name: "a.png" },
        { ref: "/uploaded/image-1", name: "b.png" },
        { ref: "/uploaded/image-2", name: "c.png" },
      ]);
      assert.equal(result.droppedNote, "");
    });
    assert.equal(startCount, 3);
    assert.deepEqual(finalizes.map((item) => item.id), ["0", "1", "2"]);
  }],
  ["returns dropped image note when upload start fails", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    await withFetch(async (url) => {
      if (String(url) === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-1","Ylro7b":"pctx-1"}', { status: 200 });
      }
      return new Response("", { status: 500 });
    }, async () => {
      const result = await mod.resolveImages({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, [{ b64: "aGVsbG8=", mime: "image/png" }]);
      assert.equal(result.fileRefs, null);
      assert.match(result.droppedNote, /some image uploads failed/);
    });
  }],
  ["fetches remote image URLs and derives filenames from URL paths", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const requests = [];
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      requests.push({ href, init });
      if (href === "https://images.example/path/remote%20image.webp?size=large") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/webp" },
        });
      }
      if (href === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-url","Ylro7b":"pctx-url"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "image/webp");
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Length"], "3");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/url-finalize" } });
      }
      if (href === "https://upload.example/url-finalize") {
        return new Response("/uploaded/url-image-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveImages({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, [{ url: "https://images.example/path/remote%20image.webp?size=large" }]);
      assert.deepEqual(result.fileRefs, [{ ref: "/uploaded/url-image-ref", name: "remote image.webp" }]);
      assert.equal(result.droppedNote, "");
    });
    assert.deepEqual(requests.map((item) => item.href), [
      "https://images.example/path/remote%20image.webp?size=large",
      "https://gemini.example/app",
      "https://content-push.googleapis.com/upload/",
      "https://upload.example/url-finalize",
    ]);
  }],
  ["uploads generic code files through the Gemini Web upload path", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const seen = [];
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      seen.push(href);
      if (href === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-file","Ylro7b":"pctx-file"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "text/x-python");
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Length"], "9");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/code" } });
      }
      if (href === "https://upload.example/code") {
        assert.equal(new TextDecoder().decode(init.body), "print(1)\n");
        return new Response("/uploaded/code-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
        generic_file_upload_max_bytes: 1024,
      }, [{ b64: "cHJpbnQoMSkK", mime: "text/x-python", filename: "../main.py" }]);
      assert.deepEqual(result, { fileRefs: [{ ref: "/uploaded/code-ref", name: "main.py" }], droppedNote: "" });
    });
    assert.deepEqual(seen, [
      "https://gemini.example/app",
      "https://content-push.googleapis.com/upload/",
      "https://upload.example/code",
    ]);
  }],
  ["uploads remote generic files with fetched MIME and sanitized URL filenames", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const seen = [];
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      seen.push(href);
      if (href === "https://files.example/src/main.ts?download=1") {
        return new Response("let x=1;", {
          status: 200,
          headers: { "content-type": "text/typescript", "content-length": "8" },
        });
      }
      if (href === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-remote-file","Ylro7b":"pctx-remote-file"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "text/typescript");
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Length"], "8");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/remote-file" } });
      }
      if (href === "https://upload.example/remote-file") {
        assert.equal(new TextDecoder().decode(init.body), "let x=1;");
        return new Response("/uploaded/remote-file-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
        generic_file_upload_max_bytes: 1024,
      }, [{ url: "https://files.example/src/main.ts?download=1" }]);
      assert.deepEqual(result, { fileRefs: [{ ref: "/uploaded/remote-file-ref", name: "main.ts" }], droppedNote: "" });
    });
    assert.deepEqual(seen, [
      "https://files.example/src/main.ts?download=1",
      "https://gemini.example/app",
      "https://content-push.googleapis.com/upload/",
      "https://upload.example/remote-file",
    ]);
  }],
  ["prefers remote content-type over filename-inferred generic file MIME", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      if (href === "https://files.example/download/report.txt") {
        return new Response("%PDF", {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": "4" },
        });
      }
      if (href === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-mime-conflict","Ylro7b":"pctx-mime-conflict"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "application/pdf");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/mime-conflict" } });
      }
      if (href === "https://upload.example/mime-conflict") return new Response("/uploaded/mime-conflict-ref", { status: 200 });
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
        generic_file_upload_max_bytes: 1024,
      }, [{ url: "https://files.example/download/report.txt" }]);
      assert.deepEqual(result, { fileRefs: [{ ref: "/uploaded/mime-conflict-ref", name: "report.txt" }], droppedNote: "" });
    });
  }],
  ["uploads empty inline generic files as zero byte attachments", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const seen = [];
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      seen.push(href);
      if (href === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-empty","Ylro7b":"pctx-empty"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "text/plain");
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Length"], "0");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/empty" } });
      }
      if (href === "https://upload.example/empty") {
        assert.equal(new TextDecoder().decode(init.body), "");
        return new Response("/uploaded/empty-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
        generic_file_upload_max_bytes: 1024,
      }, [{ type: "input_file", file_data: "", mime: "text/plain", filename: "empty.txt" }]);
      assert.deepEqual(result, { fileRefs: [{ ref: "/uploaded/empty-ref", name: "empty.txt" }], droppedNote: "" });
    });
    assert.deepEqual(seen, [
      "https://gemini.example/app",
      "https://content-push.googleapis.com/upload/",
      "https://upload.example/empty",
    ]);
  }],
  ["does not fetch Google fileData fileUri as a generic upload URL", async () => {
    mod.resetActiveGeminiCookieForTest();
    await withFetch(async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveFiles({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
        generic_file_upload_max_bytes: 1024,
      }, [{ type: "file", fileData: { fileUri: "https://files.example/main.py", mimeType: "text/x-python", displayName: "main.py" } }]);
      assert.deepEqual(result, { fileRefs: null, droppedNote: "" });
    });
  }],
  ["drops explicit generic file inputs for missing cookie invalid base64 and oversized data", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      cookie: "__Secure-1PSID=psid; SAPISID=sapi",
      sapisid: "sapi",
      request_timeout_sec: 180,
      upstream_socket: false,
      log_requests: false,
      generic_file_upload_max_bytes: 2,
    };
    const missingCookie = await mod.resolveFiles({ ...cfg, cookie: "" }, [{ b64: "AA==", mime: "application/octet-stream" }]);
    assert.equal(missingCookie.fileRefs, null);
    assert.match(missingCookie.droppedNote, /1 file\(s\).*generic file input requires a configured GEMINI_COOKIE/);

    const invalid = await mod.resolveFiles(cfg, [{ b64: "not base64!?", mime: "text/plain" }]);
    assert.equal(invalid.fileRefs, null);
    assert.match(invalid.droppedNote, /1 file\(s\).*some file uploads failed/);

    const tooLarge = await mod.resolveFiles(cfg, [{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" }]);
    assert.equal(tooLarge.fileRefs, null);
    assert.match(tooLarge.droppedNote, /1 file\(s\).*some file uploads failed/);
  }],
  ["rejects oversized inline generic base64 before invoking runtime decoders", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      cookie: "__Secure-1PSID=psid; SAPISID=sapi",
      sapisid: "sapi",
      request_timeout_sec: 180,
      upstream_socket: false,
      log_requests: false,
      generic_file_upload_max_bytes: 2,
    };
    const original = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    Object.defineProperty(Uint8Array, "fromBase64", {
      value() {
        throw new Error("fromBase64 should not be called for oversized input");
      },
      configurable: true,
      writable: true,
    });
    try {
      await withPatchedGlobal("atob", () => {
        throw new Error("atob should not be called for oversized input");
      }, async () => {
        const result = await mod.resolveFiles(cfg, [{ b64: "AAAA", mime: "application/octet-stream" }]);
        assert.equal(result.fileRefs, null);
        assert.match(result.droppedNote, /1 file\(s\).*some file uploads failed/);
      });
    } finally {
      if (original) Object.defineProperty(Uint8Array, "fromBase64", original);
      else delete Uint8Array.fromBase64;
    }
  }],
  ["rejects oversized remote generic files from content-length before reading body", async () => {
    mod.resetActiveGeminiCookieForTest();
    await withFetch(async (url) => {
      const href = String(url);
      if (href === "https://files.example/large.bin") {
        return {
          ok: true,
          headers: new Headers({ "content-length": "3" }),
          body: {
            getReader() {
              throw new Error("body should not be read for oversized content-length");
            },
          },
        };
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
        generic_file_upload_max_bytes: 2,
      }, [{ url: "https://files.example/large.bin" }]);
      assert.equal(result.fileRefs, null);
      assert.match(result.droppedNote, /1 file\(s\).*some file uploads failed/);
    });
  }],
  ["rejects oversized remote generic files while streaming and cancels the body", async () => {
    mod.resetActiveGeminiCookieForTest();
    let canceled = false;
    let released = false;
    let reads = 0;
    await withFetch(async (url) => {
      const href = String(url);
      if (href === "https://files.example/stream-large.bin") {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/octet-stream" }),
          body: {
            getReader() {
              return {
                async read() {
                  reads += 1;
                  if (reads === 1) return { done: false, value: new Uint8Array([1, 2]) };
                  if (reads === 2) return { done: false, value: new Uint8Array([3, 4]) };
                  return { done: true };
                },
                async cancel() {
                  canceled = true;
                },
                releaseLock() {
                  released = true;
                },
              };
            },
          },
        };
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
        generic_file_upload_max_bytes: 3,
      }, [{ url: "https://files.example/stream-large.bin" }]);
      assert.equal(result.fileRefs, null);
      assert.match(result.droppedNote, /1 file\(s\).*some file uploads failed/);
      assert.equal(canceled, true);
      assert.equal(released, true);
      assert.equal(reads, 2);
    });
  }],
  ["uses application octet-stream and file-number bin fallback for unknown generic files", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      if (href === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-bin","Ylro7b":"pctx-bin"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "application/octet-stream");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/bin" } });
      }
      if (href === "https://upload.example/bin") return new Response("/uploaded/bin-ref", { status: 200 });
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
        generic_file_upload_max_bytes: 1024,
      }, [{ b64: "AA==" }]);
      assert.deepEqual(result, { fileRefs: [{ ref: "/uploaded/bin-ref", name: "file-1.bin" }], droppedNote: "" });
    });
  }],
  ["retries text upload after RotateCookies refreshes an auth failure", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const seenCookies = [];
    let startCalls = 0;
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      if (href === "https://gemini.example/app") {
        seenCookies.push(init.headers.Cookie);
        return new Response('{"qKIAYe":"push-rotate","Ylro7b":"pctx-rotate"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        startCalls += 1;
        seenCookies.push(init.headers.Cookie);
        if (startCalls === 1) return new Response("", { status: 401 });
        assert.equal(init.headers.Cookie, "__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/rotated-text" } });
      }
      if (href === "https://accounts.google.com/RotateCookies") {
        assert.equal(init.headers.Cookie, "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi");
        return new Response("", {
          status: 200,
          headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
        });
      }
      if (href === "https://upload.example/rotated-text") {
        return new Response("/uploaded/rotated-text-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const ref = await mod.uploadTextFile({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, "hello after rotate", "rotated.txt");
      assert.deepEqual(ref, { ref: "/uploaded/rotated-text-ref", name: "rotated.txt" });
    });
    assert.equal(startCalls, 2);
    assert.deepEqual(seenCookies, [
      "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
      "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
      "__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
      "__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
    ]);
  }],
  ["uploads text files as Gemini file refs", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    let uploadBodyLength = 0;
    await withFetch(async (url, init = {}) => {
      if (String(url) === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-1","Ylro7b":"pctx-1"}', { status: 200 });
      }
      if (String(url) === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "text/plain; charset=utf-8");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/text" } });
      }
      uploadBodyLength = init.body.byteLength;
      return new Response("/uploaded/text-ref", { status: 200 });
    }, async () => {
      const ref = await mod.uploadTextFile({
        gemini_origin: "https://gemini.example",
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        request_timeout_sec: 180,
        upstream_socket: false,
        log_requests: false,
      }, "hello", "message.txt");
      assert.deepEqual(ref, { ref: "/uploaded/text-ref", name: "message.txt" });
      assert.equal(uploadBodyLength, 5);
    });
  }],
];

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
