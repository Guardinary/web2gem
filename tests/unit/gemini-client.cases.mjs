import assert from "./assertions.js";
import { mod, withCaches, withConsoleLog, withFetch } from "./helpers.js";

function createMemoryCache() {
  const store = new Map();
  const stats = { match: 0, put: 0, delete: 0 };
  return {
    stats,
    async match(request) {
      stats.match += 1;
      const response = store.get(request.url);
      return response ? response.clone() : undefined;
    },
    async put(request, response) {
      stats.put += 1;
      store.set(request.url, response.clone());
    },
    async delete(request) {
      stats.delete += 1;
      return store.delete(request.url);
    },
  };
}

function wrbLine(texts) {
  const inner = [
    null,
    null,
    null,
    null,
    [[null, texts]],
    "x".repeat(160),
  ];
  return JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]);
}

export const suiteName = "gemini client";
export const cases = [
  ["strips generated code artifacts from Gemini text", async () => {
    const source = [
      "keep",
      "```python?code_reference&code_event_index=1",
      "drop",
      "```",
      "http://googleusercontent.com/card_content/123",
    ].join("\n");
    assert.equal(mod.stripArtifacts(source).trim(), "keep");
    assert.equal(mod.cleanText(`  ${source}  `), "keep");
  }],
  ["extracts longest response text from WRB lines", async () => {
    const line = wrbLine(["short", "longer response"]);
    assert.deepEqual(mod.extractTextsFromLine(line), ["short", "longer response"]);
    assert.deepEqual(mod.extractTextsFromLine(` \t${line}`), ["short", "longer response"]);
    assert.deepEqual(mod.extractTextsFromLine("not json"), []);
    assert.deepEqual(mod.extractTextsFromLine(`${"x".repeat(220)} "wrb.fr"`), []);
    assert.deepEqual(mod.extractTextsFromLine(JSON.stringify([["wrb.fr", null, "{"]])), []);

    const raw = [wrbLine(["first"]), wrbLine(["first plus more"])].join("\n");
    assert.equal(mod.extractResponseText(raw), "first plus more");
  }],
  ["streams only new text deltas from repeated WRB lines", async () => {
    const extractor = mod.createStreamTextExtractor();
    assert.deepEqual([...extractor.consumeLine(wrbLine([" hello"]))], ["hello"]);
    assert.deepEqual([...extractor.consumeLine(wrbLine([" hello world"]))], [" world"]);
    assert.deepEqual([...extractor.consumeLine(wrbLine([" hello world"]))], []);
  }],
  ["builds Gemini payload with file refs and extra fields", async () => {
    const payload = mod.buildPayload(
      "prompt",
      123,
      2,
      [{ ref: "file-ref", name: "doc.txt" }],
      { 5: ["extra"], 79: 999 },
    );
    const outer = JSON.parse(new URLSearchParams(payload).get("f.req"));
    const inner = JSON.parse(outer[1]);
    assert.equal(inner.length, 102);
    assert.equal(inner[0][0], "prompt");
    assert.equal(inner[0][3][0][0][0], "file-ref");
    assert.equal(inner[0][3][0][1], "doc.txt");
    assert.equal(inner[3], null);
    assert.deepEqual(inner[5], ["extra"]);
    assert.equal(inner[79], 999);
  }],
  ["builds Gemini request URL and browser headers", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example/",
      gemini_bl: "boq test",
      cookie: "SID=ok",
    };
    const url = mod.getUrl(cfg);
    assert.match(url, /^https:\/\/gemini\.example\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate\?/);
    assert.match(url, /bl=boq%20test/);

    const headers = await mod.buildHeaders(cfg);
    assert.equal(headers.Cookie, "SID=ok");
    assert.equal(headers.Origin, "https://gemini.google.com");
    assert.equal(headers["X-Same-Domain"], "1");
    assert.equal(headers.Authorization, undefined);
  }],
  ["parses and merges cookie headers with quoted values", async () => {
    const parsed = Object.fromEntries(mod.parseCookieHeader("SID=ok; SAPISID=sapi; __Secure-1PSID=psid"));
    assert.deepEqual(parsed, {
      SID: "ok",
      SAPISID: "sapi",
      "__Secure-1PSID": "psid",
    });

    const split = mod.splitSetCookieHeader([
      "__Secure-1PSIDTS=new; Path=/; Secure",
      "NID=x; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
    ].join(", "));
    assert.equal(split.length, 2);

    const merged = mod.mergeSetCookieHeaders(
      "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
      split,
    );
    assert.equal(merged, "__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi; NID=x");

    const quoted = mod.splitSetCookieHeader([
      'A="x,y"; Path=/',
      "B=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
      "C=3; Path=/",
    ].join(", "));
    assert.deepEqual(quoted, [
      'A="x,y"; Path=/',
      "B=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
      "C=3; Path=/",
    ]);
  }],
  ["derives active Gemini cookie config without mutating input", async () => {
    mod.resetActiveGeminiCookieForTest();
    const cfg = {
      cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
      sapisid: "",
    };
    const active = mod.configWithActiveGeminiCookie(cfg);
    assert.equal(active.cookie, "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi");
    assert.equal(active.sapisid, "sapi");
    assert.equal(cfg.sapisid, "");
  }],
  ["accepts structured GEMINI_COOKIE JSON config", async () => {
    const cfg = mod.getConfig({
      GEMINI_COOKIE: JSON.stringify({
        secure_1psid: "psid",
        secure_1psidts: "ts",
        sapisid: "sapi",
      }),
    });
    assert.equal(cfg.cookie, "__Secure-1PSID=psid; __Secure-1PSIDTS=ts; SAPISID=sapi");
    assert.equal(cfg.sapisid, "sapi");
  }],
  ["rotates Gemini cookie with safe RotateCookies headers", async () => {
    mod.resetActiveGeminiCookieForTest();
    let calls = 0;
    const cfg = {
      cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
      sapisid: "",
      request_timeout_sec: 180,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async (url, init) => {
      calls += 1;
      assert.equal(String(url), "https://accounts.google.com/RotateCookies");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Cookie, cfg.cookie);
      assert.equal(init.headers.Origin, "https://accounts.google.com");
      assert.equal(init.headers.Referer, "https://accounts.google.com/");
      assert.equal(init.headers["Accept-Language"], "en-US,en;q=0.9");
      assert.match(init.headers["User-Agent"], /Mozilla\/5\.0/);
      return new Response("", {
        status: 200,
        headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
      });
    }, async () => {
      const rotated = await mod.rotateGeminiCookieForRetry(cfg);
      assert.equal(calls, 1);
      assert.equal(rotated.cookie, "__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi");
      assert.equal(rotated.sapisid, "sapi");
    });
  }],
  ["debounces failed cookie rotation after upstream rejection", async () => {
    mod.resetActiveGeminiCookieForTest();
    const cfg = {
      cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
      sapisid: "",
      request_timeout_sec: 180,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async () => new Response("", { status: 401 }), async () => {
      assert.equal(await mod.rotateGeminiCookieForRetry(cfg), null);
      const rotated = await mod.rotateGeminiCookieForRetryWithReason(cfg);
      assert.equal(rotated.config, null);
      assert.equal(rotated.reason, "recent_rotation");
    });
  }],
  ["rejects cookie rotation when no updated cookie returns", async () => {
    mod.resetActiveGeminiCookieForTest();
    const cfg = {
      cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
      sapisid: "",
      request_timeout_sec: 180,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async () => new Response("", { status: 200 }), async () => {
      assert.equal(await mod.rotateGeminiCookieForRetry(cfg), null);
    });
  }],
  ["coalesces concurrent cookie rotation requests", async () => {
    mod.resetActiveGeminiCookieForTest();
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const cfg = {
      cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
      sapisid: "",
      request_timeout_sec: 180,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async () => {
      calls += 1;
      await gate;
      return new Response("", {
        status: 200,
        headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
      });
    }, async () => {
      const first = mod.rotateGeminiCookieForRetry(cfg);
      const second = mod.rotateGeminiCookieForRetry(cfg);
      release();
      const results = await Promise.all([first, second]);
      assert.equal(calls, 1);
      assert.equal(results[0].cookie, "__Secure-1PSID=psid; __Secure-1PSIDTS=new");
      assert.equal(results[1].cookie, "__Secure-1PSID=psid; __Secure-1PSIDTS=new");
    });
  }],
  ["honors retry attempt limits", async () => {
    const cfg = { retry_attempts: 2, retry_delay_sec: 0, log_requests: true };
    const err = new Error("boom secret");
    err.code = "retry_test";
    err.status = 502;
    const logs = [];
    await withConsoleLog((line) => logs.push(String(line)), async () => {
      assert.equal(await mod.waitBeforeRetry(cfg, 0, err, "Retry"), true);
      assert.equal(await mod.waitBeforeRetry(cfg, 1, err, "Retry"), false);
    });
    assert.deepEqual(logs, ["[web2gem] Retry 1/2 type=Error code=retry_test status=502"]);
    assert.doesNotMatch(logs[0], /boom secret/);
  }],
  ["caches Gemini build labels in the Workers cache API", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "configured-bl",
      log_requests: false,
    };
    const cache = createMemoryCache();
    await withCaches(cache, async () => {
      assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "");
      await mod.setCachedGeminiBuildLabel(cfg, "cached-bl");
      assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "cached-bl");
      assert.equal(cache.stats.match, 1);

      const active = await mod.configWithCachedGeminiBuildLabel(cfg);
      assert.equal(active.gemini_bl, "cached-bl");
      assert.equal(cfg.gemini_bl, "configured-bl");
      assert.equal(cache.stats.match, 1);
    });
  }],
  ["persists Gemini build labels with waitUntil when available", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "configured-bl",
      log_requests: false,
    };
    const cache = createMemoryCache();
    const pending = [];
    await withCaches(cache, async () => {
      await mod.setCachedGeminiBuildLabel({
        ...cfg,
        execution_ctx: {
          waitUntil(promise) {
            pending.push(promise);
          },
        },
      }, "waituntil-bl");
      assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "waituntil-bl");
      assert.equal(cache.stats.match, 0);
      assert.equal(pending.length, 1);
      await Promise.all(pending);
      assert.equal(cache.stats.put, 1);
    });
  }],
  ["drops stale cached Gemini build labels", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "configured-bl",
      log_requests: false,
    };
    const cache = createMemoryCache();
    await cache.put(
      new Request(`https://internal-cache/gemini-bl/${encodeURIComponent("https://gemini.example")}`),
      new Response(JSON.stringify({
        gemini_bl: "stale-bl",
        created_at_ms: Date.now() - 13 * 60 * 60 * 1000,
      })),
    );
    await withCaches(cache, async () => {
      assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "");
      assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "");
    });
  }],
  ["refreshes Gemini build labels once for concurrent callers", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      cookie: "SID=ok",
      upstream_socket: false,
      log_requests: false,
    };
    const cache = createMemoryCache();
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await withCaches(cache, async () => {
      await withFetch(async (url, init) => {
        calls += 1;
        assert.equal(String(url), "https://gemini.example/app");
        assert.equal(init.headers.Cookie, "SID=ok");
        await gate;
        return new Response('<script>{"cfb2h":"fresh-bl"}</script>', { status: 200 });
      }, async () => {
        const first = mod.getFreshGeminiBuildLabel(cfg);
        const second = mod.getFreshGeminiBuildLabel(cfg);
        release();
        assert.deepEqual(await Promise.all([first, second]), ["fresh-bl", "fresh-bl"]);
        assert.equal(calls, 1);
        assert.equal(await mod.getCachedGeminiBuildLabel(cfg), "fresh-bl");
      });
    });
  }],
  ["reports rejected cookie rotation reason and upstream status", async () => {
    mod.resetActiveGeminiCookieForTest();
    const cfg = {
      cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old",
      sapisid: "",
      request_timeout_sec: 180,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async () => new Response("", { status: 403 }), async () => {
      const rotated = await mod.rotateGeminiCookieForRetryWithReason(cfg);
      assert.equal(rotated.config, null);
      assert.equal(rotated.reason, "rotation_rejected");
      assert.equal(rotated.upstreamStatus, 403);
    });
  }],
  ["redacts cookies from invalid cookie diagnostics", async () => {
    const err = mod.invalidGeminiCookieError(
      { cookie: "SID=bad" },
      403,
      null,
      "rotation_no_update",
    );
    assert.equal(err.code, "invalid_gemini_cookie");
    assert.equal(err.reason, "RotateCookies completed but did not return an updated cookie");
    assert.match(err.message, /Diagnostic: RotateCookies completed but did not return an updated cookie\./);
    assert.doesNotMatch(err.message, /SID=bad/);
  }],
  ["invalidates page token cache after cookie rotation", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const cfg = {
      gemini_origin: "https://gemini.example",
      cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
      sapisid: "",
      request_timeout_sec: 180,
      upstream_socket: false,
      log_requests: false,
    };
    const pageCookies = [];
    let appCalls = 0;
    await withFetch(async (url, init) => {
      const href = String(url);
      if (href === "https://gemini.example/app") {
        appCalls += 1;
        pageCookies.push(init.headers.Cookie);
        return new Response(`{"SNlM0e":"at-${appCalls}"}`, { status: 200 });
      }
      if (href === "https://accounts.google.com/RotateCookies") {
        return new Response("", {
          status: 200,
          headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const first = await mod.getPageTokens(cfg);
      assert.equal(first.at, "at-1");
      const rotated = await mod.rotateGeminiCookieForRetry(cfg);
      assert.equal(rotated.cookie, "__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi");
      const second = await mod.getPageTokens(cfg);
      assert.equal(second.at, "at-2");
      assert.deepEqual(pageCookies, [
        "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
        "__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi",
      ]);
      assert.equal(appCalls, 2);
    });
  }],
  ["deduplicates repeated active cookie names", async () => {
    mod.resetActiveGeminiCookieForTest();
    const active = mod.configWithActiveGeminiCookie({
      cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; __Secure-1PSIDTS=new; SAPISID=sapi",
      sapisid: "",
    });
    assert.equal(active.cookie, "__Secure-1PSID=psid; __Secure-1PSIDTS=new; SAPISID=sapi");
  }],
  ["generates text with page auth token appended for cookie requests", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const calls = [];
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "__Secure-1PSID=psid; SAPISID=sapi",
      sapisid: "sapi",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://gemini.example/app") {
        return new Response('{"SNlM0e":"at-test"}', { status: 200 });
      }
      assert.match(String(url), /StreamGenerate/);
      assert.match(String(init.body), /&at=at-test/);
      return new Response([
        JSON.stringify([["wrb.fr", null, JSON.stringify([null, null, null, null, [[null, ["hello"]]], "x".repeat(160)])]]),
      ].join("\n"), { status: 200 });
    }, async () => {
      const text = await mod.generate(cfg, "prompt", 1, 4, null, null);
      assert.equal(text, "hello");
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.headers.Cookie, cfg.cookie);
  }],
  ["rejects cookie requests when Gemini page auth token is missing", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const calls = [];
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "SID=ok",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async (url) => {
      calls.push(String(url));
      if (String(url) === "https://gemini.example/app") return new Response("<html>no at token</html>", { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      try {
        await mod.generate(cfg, "prompt", 1, 4, null, null);
        throw new Error("expected missing page token failure");
      } catch (err) {
        assert.equal(err.code, "invalid_gemini_cookie");
        assert.match(err.message, /GEMINI_COOKIE/);
      }
    });
    assert.deepEqual(calls, ["https://gemini.example/app"]);
  }],
  ["reports cookie rotation failure when StreamGenerate rejects the cookie", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const calls = [];
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "__Secure-1PSID=psid; SAPISID=sapi",
      sapisid: "sapi",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async (url) => {
      const href = String(url);
      calls.push(href);
      if (href === "https://gemini.example/app") return new Response('{"SNlM0e":"at-test"}', { status: 200 });
      if (href === "https://accounts.google.com/RotateCookies") return new Response("", { status: 200 });
      assert.match(href, /StreamGenerate/);
      return new Response("rejected", { status: 401 });
    }, async () => {
      try {
        await mod.generate(cfg, "prompt", 1, 4, null, null);
        throw new Error("expected invalid cookie failure");
      } catch (err) {
        assert.equal(err.code, "invalid_gemini_cookie");
        assert.equal(err.reason, "RotateCookies completed but did not return an updated cookie");
        assert.equal(err.upstreamStatus, 401);
      }
    });
    assert.equal(calls.some((href) => href === "https://accounts.google.com/RotateCookies"), true);
  }],
  ["retries generate after successful cookie rotation", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const calls = [];
    let appCalls = 0;
    let streamCalls = 0;
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "__Secure-1PSID=psid; __Secure-1PSIDTS=old; SAPISID=sapi",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 2,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      calls.push({ href, cookie: init.headers && init.headers.Cookie, body: String(init.body || "") });
      if (href === "https://gemini.example/app") {
        appCalls += 1;
        return new Response(`{"SNlM0e":"at-${appCalls}"}`, { status: 200 });
      }
      if (href === "https://accounts.google.com/RotateCookies") {
        assert.match(init.headers.Cookie, /__Secure-1PSIDTS=old/);
        return new Response("", {
          status: 200,
          headers: { "set-cookie": "__Secure-1PSIDTS=new; Path=/; Secure" },
        });
      }
      assert.match(href, /StreamGenerate/);
      streamCalls += 1;
      if (streamCalls === 1) return new Response("cookie rejected", { status: 401 });
      assert.match(init.headers.Cookie, /__Secure-1PSIDTS=new/);
      assert.match(String(init.body), /&at=at-2/);
      return new Response(wrbLine(["after cookie rotation"]), { status: 200 });
    }, async () => {
      const text = await mod.generate(cfg, "prompt", 1, 4, null, null);
      assert.equal(text, "after cookie rotation");
    });
    assert.equal(streamCalls, 2);
    assert.equal(calls.some((call) => call.href === "https://accounts.google.com/RotateCookies"), true);
  }],
  ["refreshes Gemini build label and retries empty non-stream responses", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "old-bl",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 2,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    const streamUrls = [];
    await withFetch(async (url) => {
      const href = String(url);
      if (href === "https://gemini.example/app") {
        return new Response('<html>{"cfb2h":"fresh-bl"}</html>', { status: 200 });
      }
      streamUrls.push(href);
      if (streamUrls.length === 1) return new Response("no parseable text", { status: 200 });
      return new Response(wrbLine(["after refresh"]), { status: 200 });
    }, async () => {
      const text = await mod.generate(cfg, "prompt", 1, 4, null, null);
      assert.equal(text, "after refresh");
    });
    assert.match(streamUrls[0], /bl=old-bl/);
    assert.match(streamUrls[1], /bl=fresh-bl/);
  }],
  ["throws explicit non-stream upstream error when refresh cannot recover", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "stale-bl",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    const calls = [];
    await withFetch(async (url) => {
      const href = String(url);
      calls.push(href);
      if (href === "https://gemini.example/app") return new Response("<html>no fresh build label</html>", { status: 200 });
      return new Response("upstream failure without wrb text", { status: 502 });
    }, async () => {
      try {
        await mod.generate(cfg, "prompt", 1, 4, null, null);
        throw new Error("expected non-stream upstream failure");
      } catch (err) {
        assert.match(err.message, /HTTP 502 returned no parseable text/);
      }
    });
    assert.equal(calls.some((href) => href === "https://gemini.example/app"), true);
  }],
  ["throws explicit non-stream upstream empty error for HTTP 200 responses", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "stale-bl",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async (url) => {
      if (String(url) === "https://gemini.example/app") return new Response("<html>no fresh build label</html>", { status: 200 });
      return new Response("upstream completed without wrb text", { status: 200 });
    }, async () => {
      try {
        await mod.generate(cfg, "prompt", 1, 4, null, null);
        throw new Error("expected upstream empty response");
      } catch (err) {
        assert.equal(err.code, "upstream_empty_response");
        assert.equal(err.status, 502);
        assert.equal(err.upstreamStatus, 200);
        assert.equal(err.rawLength, "upstream completed without wrb text".length);
      }
    });
  }],
  ["classifies data-analysis empty responses for uploaded files", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async () => new Response("data_analysis_tool returned no final text", { status: 200 }), async () => {
      try {
        await mod.generate(cfg, "prompt", 1, 4, null, [{ ref: "file-ref", name: "data.csv" }]);
        throw new Error("expected data-analysis empty response");
      } catch (err) {
        assert.equal(err.code, "data_analysis_empty_response");
        assert.match(err.message, /data_analysis_tool/);
      }
    });
  }],
  ["classifies large prompt empty responses before generic retry exhaustion", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 10,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async () => new Response("no parseable text", { status: 200 }), async () => {
      try {
        await mod.generate(cfg, "x".repeat(20), 1, 4, null, null);
        throw new Error("expected large prompt empty response");
      } catch (err) {
        assert.equal(err.code, "large_prompt_empty_response");
        assert.equal(err.thresholdBytes, 10);
        assert.equal(err.promptBytes > err.thresholdBytes, true);
      }
    });
  }],
  ["aborts Gemini streams before starting upstream fetch", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    const ac = new AbortController();
    ac.abort("stop now");
    await withFetch(async () => {
      throw new Error("fetch should not run");
    }, async () => {
      try {
        for await (const _delta of mod.generateStream(cfg, "prompt", 1, 4, null, null, { signal: ac.signal })) {
          throw new Error("stream should not yield");
        }
        throw new Error("expected abort");
      } catch (err) {
        assert.equal(err.name, "AbortError");
        assert.equal(err.code, "request_aborted");
        assert.match(err.message, /stop now/);
      }
    });
  }],
  ["throws for stream responses with no body and no parseable fallback text", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async () => new Response(null, { status: 502 }), async () => {
      try {
        for await (const _delta of mod.generateStream(cfg, "prompt", 1, 4, null, null)) {
          throw new Error("stream should not yield");
        }
        throw new Error("expected empty stream error");
      } catch (err) {
        assert.equal(err.code, "upstream_empty_response");
        assert.equal(err.status, 502);
        assert.equal(err.upstreamStatus, 502);
        assert.equal(err.rawLength, 0);
      }
    });
  }],
  ["streams fallback text when Gemini response has no body", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async () => new Response(
      JSON.stringify([["wrb.fr", null, JSON.stringify([null, null, null, null, [[null, ["stream fallback"]]], "x".repeat(160)])]]),
      { status: 200 },
    ), async () => {
      const chunks = [];
      for await (const delta of mod.generateStream(cfg, "prompt", 1, 4, null, null)) chunks.push(delta);
      assert.deepEqual(chunks, ["stream fallback"]);
    });
  }],
  ["streams fallback text from response-like objects with no body", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async () => ({
      ok: true,
      status: 200,
      body: null,
      async text() {
        return wrbLine(["response-like fallback"]);
      },
    }), async () => {
      const chunks = [];
      for await (const delta of mod.generateStream(cfg, "prompt", 1, 4, null, null)) chunks.push(delta);
      assert.deepEqual(chunks, ["response-like fallback"]);
    });
  }],
  ["throws when streamed Gemini body has no parseable text", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    const calls = [];
    await withFetch(async (url) => {
      const href = String(url);
      calls.push(href);
      if (href === "https://gemini.example/app") return new Response("<html>no fresh build label</html>", { status: 200 });
      return new Response("not parseable", { status: 502 });
    }, async () => {
      try {
        for await (const _delta of mod.generateStream(cfg, "prompt", 1, 4, null, null)) {
          throw new Error("stream should not yield");
        }
        throw new Error("expected parse failure");
      } catch (err) {
        assert.equal(err.code, "upstream_empty_response");
        assert.equal(err.status, 502);
        assert.equal(err.upstreamStatus, 502);
        assert.equal(err.rawLength, "not parseable".length);
      }
    });
    assert.equal(calls.some((href) => href === "https://gemini.example/app"), true);
  }],
  ["throws explicit stream upstream empty error for HTTP 200 responses", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "stale-stream-bl",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    await withFetch(async (url) => {
      if (String(url) === "https://gemini.example/app") return new Response("<html>no fresh build label</html>", { status: 200 });
      return new Response("stream completed without wrb text", { status: 200 });
    }, async () => {
      try {
        for await (const _delta of mod.generateStream(cfg, "prompt", 1, 4, null, null)) {
          throw new Error("stream should not yield");
        }
        throw new Error("expected upstream empty stream response");
      } catch (err) {
        assert.equal(err.code, "upstream_empty_response");
        assert.equal(err.status, 502);
        assert.equal(err.upstreamStatus, 200);
        assert.equal(err.rawLength, "stream completed without wrb text".length);
      }
    });
  }],
  ["refreshes Gemini build label and retries empty stream bodies", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "old-stream-bl",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 2,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    const streamUrls = [];
    await withFetch(async (url) => {
      const href = String(url);
      if (href === "https://gemini.example/app") return new Response('<html>{"cfb2h":"fresh-stream-bl"}</html>', { status: 200 });
      streamUrls.push(href);
      if (streamUrls.length === 1) return new Response("not parseable yet", { status: 200 });
      return new Response(wrbLine(["after stream refresh"]), { status: 200 });
    }, async () => {
      const chunks = [];
      for await (const delta of mod.generateStream(cfg, "prompt", 1, 4, null, null)) chunks.push(delta);
      assert.deepEqual(chunks, ["after stream refresh"]);
    });
    assert.match(streamUrls[0], /bl=old-stream-bl/);
    assert.match(streamUrls[1], /bl=fresh-stream-bl/);
  }],
  ["adapts resolved models through the Gemini completion provider", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    const provider = mod.createGeminiCompletionProvider(cfg);
    await withFetch(async (url, init) => {
      assert.match(String(url), /StreamGenerate/);
      const payload = new URLSearchParams(String(init.body)).get("f.req");
      assert.match(payload, /provider prompt/);
      assert.match(payload, /file-ref/);
      return new Response(wrbLine(["provider answer"]), { status: 200 });
    }, async () => {
      const text = await provider.generateText({
        prompt: "provider prompt",
        rm: { name: "gemini-3.5-flash", modeId: 1, thinkMode: 4, extra: null },
        fileRefs: [{ ref: "file-ref", name: "doc.txt" }],
      });
      assert.equal(text, "provider answer");
    });
  }],
  ["streams text through the Gemini completion provider and rejects unresolved models", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    const provider = mod.createGeminiCompletionProvider(cfg);
    await withFetch(async () => new Response([
      wrbLine(["hello"]),
      wrbLine(["hello world"]),
    ].join("\n"), { status: 200 }), async () => {
      const deltas = [];
      for await (const delta of provider.streamText({
        prompt: "stream prompt",
        rm: { name: "gemini-3.5-flash", modeId: 1, thinkMode: 4, extra: null },
        fileRefs: null,
      }, { signal: new AbortController().signal })) {
        deltas.push(delta);
      }
      assert.deepEqual(deltas, ["hello", " world"]);
    });
    await assert.rejects(() => provider.generateText({
      prompt: "bad model",
      rm: { error: "model_not_found" },
      fileRefs: null,
    }), /model_not_found/);
  }],
  ["forwards image resolution and text uploads through the Gemini completion provider", async () => {
    const cfg = {
      gemini_origin: "https://gemini.example",
      gemini_bl: "boq_test",
      cookie: "",
      sapisid: "",
      request_timeout_sec: 180,
      retry_attempts: 1,
      retry_delay_sec: 0,
      current_input_file_min_bytes: 1000000,
      upstream_socket: false,
      log_requests: false,
    };
    const provider = mod.createGeminiCompletionProvider(cfg);
    assert.deepEqual(await provider.resolveImages([]), { fileRefs: null, droppedNote: "" });

    const calls = [];
    await withFetch(async (url, init) => {
      calls.push({ url: String(url), body: init && init.body });
      if (String(url) === "https://gemini.example/app") {
        return new Response("<html></html>", { status: 200 });
      }
      if (String(url) === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.method, "POST");
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "text/plain; charset=utf-8");
        return new Response("", {
          status: 200,
          headers: { "x-goog-upload-url": "https://upload.example/finalize" },
        });
      }
      if (String(url) === "https://upload.example/finalize") {
        assert.equal(init.method, "POST");
        assert.equal(init.headers["X-Goog-Upload-Command"], "upload, finalize");
        return new Response("/uploaded/context-file", { status: 200 });
      }
      throw new Error(`unexpected upload URL: ${url}`);
    }, async () => {
      const uploaded = await provider.uploadTextFile("context text", "context.txt");
      assert.deepEqual(uploaded, { ref: "/uploaded/context-file", name: "context.txt" });
    });
    assert.deepEqual(calls.map((call) => call.url), [
      "https://gemini.example/app",
      "https://content-push.googleapis.com/upload/",
      "https://upload.example/finalize",
    ]);
  }],
];
