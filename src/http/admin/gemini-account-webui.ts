const ADMIN_UI_PATH = "/admin/gemini/accounts/ui";

export function isGeminiAccountAdminUiPath(path: string): boolean {
  return path === ADMIN_UI_PATH;
}

export function handleGeminiAccountAdminUiRequest(request: Request): Response {
  if (request.method.toUpperCase() !== "GET") {
    return new Response("admin UI route not found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return new Response(GEMINI_ACCOUNT_ADMIN_HTML, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

const GEMINI_ACCOUNT_ADMIN_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gemini Account Pool</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f0e6;
      --surface: rgba(255, 252, 246, 0.9);
      --surface-solid: #fffdf8;
      --surface-soft: #f2eadf;
      --text: #332c24;
      --muted: #7a6f63;
      --line: rgba(167, 151, 130, 0.34);
      --line-strong: rgba(120, 106, 88, 0.42);
      --primary: #332b24;
      --primary-hover: #4a4036;
      --secondary: #eee3d5;
      --accent: #c8dfb9;
      --danger: #b42318;
      --danger-bg: #fff1f0;
      --warn: #9a5b13;
      --warn-bg: #fff7e6;
      --ok: #447a3c;
      --ok-bg: #eef8e8;
      --info: #4f6680;
      --info-bg: #eff4f8;
      --shadow-soft: 0 22px 70px -42px rgba(58, 48, 38, 0.42);
      --shadow-lift: 0 30px 110px -55px rgba(44, 36, 29, 0.5);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background:
        linear-gradient(135deg, #fbf7ee 0%, #f2e7d8 52%, #f4efe3 100%);
      color: var(--text);
      font-size: 14px;
    }
    button, input, select { font: inherit; }
    button {
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255, 253, 248, 0.82);
      color: var(--text);
      cursor: pointer;
      padding: 0 14px;
      font-weight: 700;
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.7) inset, 0 10px 28px -24px rgba(58, 48, 38, 0.65);
      transition: border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
    }
    button:hover:not(:disabled) {
      border-color: var(--line-strong);
      background: rgba(255, 255, 255, 0.92);
      box-shadow: 0 18px 40px -28px rgba(58, 48, 38, 0.75);
      transform: translateY(-1px);
    }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    .primary {
      background: var(--primary);
      border-color: rgba(51, 43, 36, 0.96);
      color: #fffaf2;
      box-shadow: 0 18px 40px -24px rgba(68, 64, 60, 0.9);
    }
    .primary:hover:not(:disabled) { background: var(--primary-hover); border-color: var(--primary-hover); }
    .danger { color: var(--danger); border-color: #f3b3ac; }
    .danger:hover:not(:disabled) { background: var(--danger-bg); }
    input, select {
      min-height: 40px;
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.86);
      color: var(--text);
      padding: 0 12px;
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.78) inset;
    }
    input:focus, select:focus, button:focus-visible {
      outline: 3px solid rgba(200, 223, 185, 0.62);
      outline-offset: 2px;
      border-color: #a9bf95;
    }
    label { display: grid; gap: 7px; color: var(--muted); font-size: 12px; font-weight: 700; }
    code { border-radius: 9px; background: var(--surface-soft); padding: 2px 6px; }
    .shell { width: min(1480px, calc(100% - 32px)); margin: 0 auto; padding: 18px 0 30px; }
    .topbar {
      position: sticky;
      top: 12px;
      z-index: 5;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      min-height: 70px;
      margin-bottom: 18px;
      border: 1px solid rgba(255, 255, 255, 0.78);
      border-radius: 30px;
      background: rgba(255, 252, 246, 0.84);
      box-shadow: var(--shadow-lift);
      padding: 10px 14px 10px 18px;
      backdrop-filter: blur(18px);
    }
    .brand {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 12px;
    }
    .brand-mark {
      display: inline-flex;
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255, 255, 255, 0.82);
      border-radius: 16px;
      background: #fffdf8;
      color: var(--primary);
      font-weight: 850;
      box-shadow: 0 12px 30px -24px rgba(58, 48, 38, 0.76);
    }
    h1 { margin: 0; font-size: 24px; line-height: 1.15; letter-spacing: 0; }
    .subtitle { margin-top: 5px; color: var(--muted); font-size: 13px; }
    .auth {
      display: grid;
      grid-template-columns: minmax(220px, 360px) auto auto;
      align-items: end;
      gap: 9px;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .panel, .metric {
      border: 1px solid rgba(255, 255, 255, 0.75);
      border-radius: 28px;
      background: var(--surface);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(10px);
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border-bottom: 1px solid var(--line);
      padding: 17px 18px 15px;
    }
    .panel-title { font-weight: 800; letter-spacing: 0; }
    .panel-body { padding: 18px; }
    .grid { display: grid; gap: 13px; }
    .help { color: var(--muted); font-size: 12px; line-height: 1.65; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(5, minmax(120px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .metric { padding: 16px; }
    .metric .label { color: var(--muted); font-size: 12px; font-weight: 800; }
    .metric .value { margin-top: 9px; font-size: 27px; font-weight: 850; line-height: 1; color: var(--primary); }
    .filters {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 170px 140px auto;
      gap: 9px;
      align-items: end;
    }
    .table-wrap { overflow-x: auto; border-top: 1px solid var(--line); }
    table { width: 100%; min-width: 1120px; border-collapse: collapse; }
    th, td { border-bottom: 1px solid rgba(167, 151, 130, 0.25); padding: 12px 14px; text-align: left; vertical-align: middle; }
    th {
      background: rgba(242, 234, 223, 0.72);
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    tr:hover td { background: rgba(255, 255, 255, 0.48); }
    .row-main { display: grid; gap: 4px; min-width: 180px; }
    .row-title { font-weight: 800; color: var(--text); }
    .row-sub { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 25px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 10px;
      background: rgba(255, 253, 248, 0.82);
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }
    .status-active { border-color: #c6e7bd; background: var(--ok-bg); color: var(--ok); }
    .status-disabled { border-color: #d8cdc0; background: #f2eadf; color: #74695e; }
    .status-rate_limited, .status-cooling_down, .status-needs_cookie_update { border-color: #f2d391; background: var(--warn-bg); color: var(--warn); }
    .status-auth_failed, .status-hard_blocked, .status-missing_cookie { border-color: #f2b9b1; background: var(--danger-bg); color: var(--danger); }
    .status-transient_failed, .status-needs_user_action, .status-capability_mismatch { border-color: #c8d7e1; background: var(--info-bg); color: var(--info); }
    .cell-actions { display: inline-flex; gap: 6px; }
    .cell-actions button { min-height: 32px; border-radius: 11px; padding: 0 9px; font-size: 12px; }
    .empty, .loading {
      padding: 46px 16px;
      text-align: center;
      color: var(--muted);
    }
    .toast {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 10;
      display: grid;
      gap: 8px;
      width: min(420px, calc(100vw - 32px));
    }
    .toast-item {
      border: 1px solid rgba(255, 255, 255, 0.78);
      border-left: 5px solid var(--accent);
      border-radius: 18px;
      background: rgba(255, 252, 246, 0.96);
      box-shadow: 0 24px 54px -34px rgba(58, 48, 38, 0.7);
      padding: 12px 14px;
      color: var(--text);
      overflow-wrap: anywhere;
      backdrop-filter: blur(12px);
    }
    .toast-item.error { border-left-color: var(--danger); }
    .muted { color: var(--muted); }
    .nowrap { white-space: nowrap; }
    @media (max-width: 980px) {
      .topbar, .layout { grid-template-columns: 1fr; display: grid; }
      .topbar { position: static; }
      .auth { grid-template-columns: 1fr auto auto; }
      .metrics { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .filters { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 620px) {
      .shell { width: min(100% - 20px, 1480px); padding-top: 10px; }
      .auth, .filters { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: 1fr; }
      .topbar { border-radius: 24px; padding: 14px; }
      h1 { font-size: 21px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div class="brand">
        <span class="brand-mark">G</span>
        <div>
          <h1>Gemini Account Pool</h1>
          <div class="subtitle">D1-backed admin console for Gemini Web sessions</div>
        </div>
      </div>
      <form id="auth-form" class="auth">
        <label>Admin key
          <input id="admin-key" type="password" autocomplete="current-password" placeholder="ADMIN_KEY or one ADMIN_KEYS value">
        </label>
        <button id="save-key" class="primary" type="submit">Save</button>
        <button id="clear-key" type="button">Clear</button>
      </form>
    </div>

    <section class="layout">
      <div class="grid">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Import Gemini account</div>
          </div>
          <div class="panel-body">
            <form id="import-form" class="grid">
              <label>Label
                <input id="label" placeholder="Optional display label">
              </label>
              <label>__Secure-1PSID
                <input id="psid" autocomplete="off" placeholder="Value only">
              </label>
              <label>__Secure-1PSIDTS
                <input id="psidts" autocomplete="off" placeholder="Value only">
              </label>
              <div class="help">Only paste the value after the equals sign. Do not paste cookie names, equals signs, semicolons, full Cookie headers, or JSON blobs.</div>
              <div class="actions">
                <button id="import-submit" class="primary" type="submit">Import</button>
                <button id="import-reset" type="button">Reset</button>
              </div>
            </form>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Batch actions</div>
            <span id="selected-count" class="badge">0 selected</span>
          </div>
          <div class="panel-body">
            <div class="actions">
              <button data-batch="refresh" type="button">Refresh</button>
              <button data-batch="check" type="button">Check</button>
              <button data-batch="enable" type="button">Enable</button>
              <button data-batch="disable" type="button">Disable</button>
              <button data-batch="delete" class="danger" type="button">Delete</button>
            </div>
            <p class="help">Actions use account identifiers from the sanitized admin API response. No session secrets are displayed here.</p>
          </div>
        </section>
      </div>

      <section>
        <div class="metrics" id="metrics"></div>
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Accounts</div>
            <div class="actions">
              <button id="reload" type="button">Reload</button>
              <button id="select-visible" type="button">Select visible</button>
              <button id="clear-selection" type="button">Clear selection</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="filters">
              <label>Search
                <input id="query" placeholder="Label, ID, row ID, source, status">
              </label>
              <label>Status
                <select id="status-filter">
                  <option value="">All statuses</option>
                  <option value="active">active</option>
                  <option value="disabled">disabled</option>
                  <option value="auth_failed">auth_failed</option>
                  <option value="needs_cookie_update">needs_cookie_update</option>
                  <option value="rate_limited">rate_limited</option>
                  <option value="cooling_down">cooling_down</option>
                  <option value="transient_failed">transient_failed</option>
                  <option value="hard_blocked">hard_blocked</option>
                  <option value="needs_user_action">needs_user_action</option>
                  <option value="missing_cookie">missing_cookie</option>
                  <option value="capability_mismatch">capability_mismatch</option>
                </select>
              </label>
              <label>Enabled
                <select id="enabled-filter">
                  <option value="">All</option>
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </label>
              <button id="apply-filters" type="button">Apply</button>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="nowrap">Select</th>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Enabled</th>
                  <th>Session</th>
                  <th>Last success</th>
                  <th>Last failure</th>
                  <th>Errors</th>
                  <th>Source</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="account-rows">
                <tr><td class="empty" colspan="10">Enter an admin key, then load accounts.</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </section>
  </main>
  <div id="toast" class="toast" aria-live="polite" aria-atomic="true"></div>
  <script>
    (function () {
      "use strict";
      var API_PATH = "/admin/gemini/accounts";
      var KEY_STORAGE = "web2gem_gemini_admin_key";
      var state = {
        accounts: [],
        visible: [],
        selected: new Set(),
        loading: false
      };
      var els = {
        key: document.getElementById("admin-key"),
        authForm: document.getElementById("auth-form"),
        clearKey: document.getElementById("clear-key"),
        importForm: document.getElementById("import-form"),
        importReset: document.getElementById("import-reset"),
        label: document.getElementById("label"),
        psid: document.getElementById("psid"),
        psidts: document.getElementById("psidts"),
        rows: document.getElementById("account-rows"),
        metrics: document.getElementById("metrics"),
        selectedCount: document.getElementById("selected-count"),
        reload: document.getElementById("reload"),
        selectVisible: document.getElementById("select-visible"),
        clearSelection: document.getElementById("clear-selection"),
        query: document.getElementById("query"),
        status: document.getElementById("status-filter"),
        enabled: document.getElementById("enabled-filter"),
        applyFilters: document.getElementById("apply-filters"),
        toast: document.getElementById("toast")
      };

      function text(value) {
        return String(value == null ? "" : value);
      }
      function escapeHtml(value) {
        return text(value).replace(/[&<>"']/g, function (char) {
          return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
        });
      }
      function toast(message, kind) {
        var item = document.createElement("div");
        item.className = "toast-item" + (kind === "error" ? " error" : "");
        item.textContent = message;
        els.toast.appendChild(item);
        window.setTimeout(function () { item.remove(); }, 5000);
      }
      function adminKey() {
        return text(els.key.value).trim();
      }
      function authHeaders(json) {
        var key = adminKey();
        if (!key) throw new Error("Admin key is required");
        var headers = { Authorization: "Bearer " + key };
        if (json) headers["Content-Type"] = "application/json";
        return headers;
      }
      async function api(path, options) {
        var init = options || {};
        var hasBody = Object.prototype.hasOwnProperty.call(init, "body");
        var response = await fetch(path, {
          method: init.method || "GET",
          headers: authHeaders(hasBody),
          body: hasBody ? JSON.stringify(init.body || {}) : undefined
        });
        var contentType = response.headers.get("content-type") || "";
        var body = contentType.indexOf("application/json") >= 0 ? await response.json() : await response.text();
        if (!response.ok) {
          var message = body && body.error && (body.error.message || body.error.code) ? (body.error.message || body.error.code) : "Request failed with status " + response.status;
          throw new Error(message);
        }
        return body;
      }
      function identifier(account) {
        var item = {};
        if (account.id) item.id = account.id;
        if (account.row_id) item.row_id = account.row_id;
        return item;
      }
      function identifierKey(account) {
        return text(account.id || account.row_id);
      }
      function selectedIdentifiers() {
        return state.accounts.filter(function (account) {
          return state.selected.has(identifierKey(account));
        }).map(identifier).filter(function (item) {
          return item.id || item.row_id;
        });
      }
      function validateCookieValue(value, name) {
        var normalized = text(value).trim();
        if (!normalized) throw new Error(name + " is required");
        if (normalized.indexOf("=") >= 0 || normalized.indexOf(";") >= 0 || normalized[0] === "{" || normalized[0] === "[" || /__Secure-1PSID/i.test(normalized)) {
          throw new Error(name + " must be a value only");
        }
        return normalized;
      }
      function formatTime(value) {
        var n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return "-";
        try {
          return new Date(n).toLocaleString();
        } catch (_) {
          return "-";
        }
      }
      function statusClass(status) {
        return "badge status-" + text(status).replace(/_/g, "_");
      }
      function renderMetrics() {
        var total = state.accounts.length;
        var active = state.accounts.filter(function (item) { return item.status === "active" && Number(item.enabled) === 1; }).length;
        var disabled = state.accounts.filter(function (item) { return Number(item.enabled) !== 1 || item.status === "disabled"; }).length;
        var attention = state.accounts.filter(function (item) {
          return ["auth_failed", "needs_cookie_update", "rate_limited", "cooling_down", "hard_blocked", "needs_user_action", "missing_cookie", "capability_mismatch"].indexOf(item.status) >= 0;
        }).length;
        var selected = state.selected.size;
        var cards = [
          ["Total", total],
          ["Available", active],
          ["Needs attention", attention],
          ["Disabled", disabled],
          ["Selected", selected]
        ];
        els.metrics.innerHTML = cards.map(function (card) {
          return '<div class="metric"><div class="label">' + escapeHtml(card[0]) + '</div><div class="value">' + escapeHtml(card[1]) + '</div></div>';
        }).join("");
      }
      function applyLocalFilters() {
        var q = text(els.query.value).trim().toLowerCase();
        state.visible = state.accounts.filter(function (account) {
          if (q) {
            var haystack = [
              account.id, account.row_id, account.label, account.status, account.state_reason,
              account.source, account.source_id, account.source_name, account.account_category
            ].map(text).join(" ").toLowerCase();
            if (haystack.indexOf(q) < 0) return false;
          }
          return true;
        });
      }
      function renderRows() {
        applyLocalFilters();
        els.selectedCount.textContent = state.selected.size + " selected";
        renderMetrics();
        if (state.loading) {
          els.rows.innerHTML = '<tr><td class="loading" colspan="10">Loading accounts...</td></tr>';
          return;
        }
        if (!state.visible.length) {
          els.rows.innerHTML = '<tr><td class="empty" colspan="10">No accounts match the current filters.</td></tr>';
          return;
        }
        els.rows.innerHTML = state.visible.map(function (account) {
          var key = identifierKey(account);
          var checked = state.selected.has(key) ? " checked" : "";
          var enabled = Number(account.enabled) === 1;
          var session = [
            account.has_cookie ? "cookie" : "",
            account.has_sapisid ? "sapisid" : "",
            account.has_session_token ? "token" : ""
          ].filter(Boolean).join(" / ") || "missing";
          return '<tr data-key="' + escapeHtml(key) + '">' +
            '<td><input type="checkbox" data-select="' + escapeHtml(key) + '"' + checked + '></td>' +
            '<td><div class="row-main"><div class="row-title">' + escapeHtml(account.label || account.id || account.row_id || "Gemini account") + '</div><div class="row-sub">' + escapeHtml(account.id || "") + '</div><div class="row-sub">' + escapeHtml(account.row_id || "") + '</div></div></td>' +
            '<td><span class="' + statusClass(account.status) + '">' + escapeHtml(account.status || "-") + '</span></td>' +
            '<td><span class="badge">' + (enabled ? "enabled" : "disabled") + '</span></td>' +
            '<td><span class="badge">' + escapeHtml(session) + '</span><div class="row-sub">' + escapeHtml(account.account_category || "") + '</div></td>' +
            '<td class="nowrap">' + escapeHtml(formatTime(account.last_success_at_ms)) + '</td>' +
            '<td class="nowrap">' + escapeHtml(formatTime(account.last_failure_at_ms)) + '</td>' +
            '<td><div class="row-main"><div class="row-sub">' + escapeHtml(account.last_error_code || "-") + '</div><div class="row-sub">' + escapeHtml(account.last_error_message_redacted || "") + '</div></div></td>' +
            '<td><div class="row-main"><div class="row-sub">' + escapeHtml(account.source || "-") + '</div><div class="row-sub">' + escapeHtml(account.source_name || account.source_id || "") + '</div></div></td>' +
            '<td><div class="cell-actions">' +
              '<button data-row-action="refresh" data-key="' + escapeHtml(key) + '">Refresh</button>' +
              '<button data-row-action="check" data-key="' + escapeHtml(key) + '">Check</button>' +
              '<button data-row-action="' + (enabled ? "disable" : "enable") + '" data-key="' + escapeHtml(key) + '">' + (enabled ? "Disable" : "Enable") + '</button>' +
              '<button class="danger" data-row-action="delete" data-key="' + escapeHtml(key) + '">Delete</button>' +
            '</div></td>' +
          '</tr>';
        }).join("");
      }
      async function loadAccounts() {
        state.loading = true;
        renderRows();
        try {
          var params = new URLSearchParams({ limit: "200" });
          if (els.status.value) params.set("status", els.status.value);
          if (els.enabled.value) params.set("enabled", els.enabled.value);
          var page = await api(API_PATH + "?" + params.toString());
          state.accounts = Array.isArray(page.items) ? page.items : [];
          state.selected.forEach(function (key) {
            if (!state.accounts.some(function (account) { return identifierKey(account) === key; })) state.selected.delete(key);
          });
          toast("Loaded " + state.accounts.length + " accounts");
        } catch (error) {
          toast(error.message || "Failed to load accounts", "error");
        } finally {
          state.loading = false;
          renderRows();
        }
      }
      async function createAccount(event) {
        event.preventDefault();
        try {
          var psid = validateCookieValue(els.psid.value, "__Secure-1PSID");
          var psidts = validateCookieValue(els.psidts.value, "__Secure-1PSIDTS");
          var payload = {
            provider: "gemini",
            "__Secure-1PSID": psid,
            "__Secure-1PSIDTS": psidts
          };
          var label = text(els.label.value).trim();
          if (label) payload.label = label;
          var result = await api(API_PATH, { method: "POST", body: payload });
          toast("Imported " + (result.added || 0) + " account");
          els.importForm.reset();
          await loadAccounts();
        } catch (error) {
          toast(error.message || "Import failed", "error");
        }
      }
      async function runAction(action, identifiers) {
        if (!identifiers.length) {
          toast("Select at least one account", "error");
          return;
        }
        if (action === "delete" && !window.confirm("Delete " + identifiers.length + " selected account(s)?")) return;
        var method = action === "delete" ? "DELETE" : "POST";
        var suffix = action === "delete" ? "" : "/" + action;
        try {
          var result = await api(API_PATH + suffix, { method: method, body: { identifiers: identifiers } });
          var changed = result.updated || result.removed || result.refreshed || result.checked || 0;
          toast(action + " completed: " + changed);
          await loadAccounts();
        } catch (error) {
          toast(error.message || action + " failed", "error");
        }
      }
      function accountByKey(key) {
        return state.accounts.find(function (account) { return identifierKey(account) === key; });
      }

      els.key.value = window.localStorage.getItem(KEY_STORAGE) || "";
      els.authForm.addEventListener("submit", function (event) {
        event.preventDefault();
        window.localStorage.setItem(KEY_STORAGE, adminKey());
        toast("Admin key saved");
        loadAccounts();
      });
      els.clearKey.addEventListener("click", function () {
        window.localStorage.removeItem(KEY_STORAGE);
        els.key.value = "";
        state.accounts = [];
        state.selected.clear();
        renderRows();
        toast("Admin key cleared");
      });
      els.importForm.addEventListener("submit", createAccount);
      els.importReset.addEventListener("click", function () { els.importForm.reset(); });
      els.reload.addEventListener("click", loadAccounts);
      els.applyFilters.addEventListener("click", loadAccounts);
      els.query.addEventListener("input", renderRows);
      els.selectVisible.addEventListener("click", function () {
        state.visible.forEach(function (account) { state.selected.add(identifierKey(account)); });
        renderRows();
      });
      els.clearSelection.addEventListener("click", function () {
        state.selected.clear();
        renderRows();
      });
      document.addEventListener("change", function (event) {
        var target = event.target;
        if (!target || !target.matches || !target.matches("input[data-select]")) return;
        var key = target.getAttribute("data-select") || "";
        if (target.checked) state.selected.add(key);
        else state.selected.delete(key);
        renderRows();
      });
      document.addEventListener("click", function (event) {
        var target = event.target;
        if (!target || !target.getAttribute) return;
        var batch = target.getAttribute("data-batch");
        if (batch) {
          runAction(batch, selectedIdentifiers());
          return;
        }
        var rowAction = target.getAttribute("data-row-action");
        if (rowAction) {
          var account = accountByKey(target.getAttribute("data-key") || "");
          if (account) runAction(rowAction, [identifier(account)]);
        }
      });
      renderRows();
      if (adminKey()) loadAccounts();
    })();
  </script>
</body>
</html>`;
