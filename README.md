# web2gem

[English](README.md) | [简体中文](README.zh.md)

Lightweight Gemini Web gateway with OpenAI-compatible and Google-compatible APIs. Deploy the single Worker bundle to Cloudflare or run it with Docker, with optional API authentication and Gemini cookie-backed features.

> You are reading the `main` branch documentation. This is the lightweight, non-persistent edition. Need multiple persistent accounts and a management console? See [`gemini-account-pool`](https://github.com/Guardinary/web2gem/tree/gemini-account-pool).

[Choose an edition](#choose-an-edition) · [Deploy to Cloudflare](#option-1-deploy-the-release-single-file-worker) · [Deploy with Docker](#option-2-deploy-with-docker) · [API examples](#api-surface)

## Contents

- [web2gem](#web2gem)
  - [Contents](#contents)
  - [Overview](#overview)
  - [Choose an Edition](#choose-an-edition)
  - [Core Features](#core-features)
  - [Before You Start](#before-you-start)
  - [API Surface](#api-surface)
    - [Health](#health)
    - [OpenAI Chat Completions](#openai-chat-completions)
    - [OpenAI Responses](#openai-responses)
    - [OpenAI Images API](#openai-images-api)
    - [Google Gemini API](#google-gemini-api)
  - [Models](#models)
  - [Quick Start](#quick-start)
    - [Option 1: Deploy the release single-file Worker](#option-1-deploy-the-release-single-file-worker)
    - [Option 2: Deploy with Docker](#option-2-deploy-with-docker)
  - [Configuration](#configuration)
  - [Authentication](#authentication)
  - [Troubleshooting](#troubleshooting)
  - [Development](#development)
  - [Testing](#testing)
  - [Project Structure](#project-structure)
  - [Security Notice](#security-notice)
  - [Acknowledgements](#acknowledgements)
  - [License](#license)

## Overview

`web2gem` lets OpenAI-compatible and Google Gemini-compatible clients use Gemini Web through a familiar HTTP API. The `main` edition is intentionally simple: it has no account database or admin console, and optional authenticated Gemini features use one runtime `GEMINI_COOKIE` that is refreshed in memory when possible.

It works well for personal deployments, simple proxies, and users who prefer a small stateless runtime. Cloudflare Workers can use `cloudflare:sockets` for upstream transport when regular `fetch` paths are rate-limited; Docker uses standard `fetch` by default.

The main compatibility targets are:

| Surface                             | Status    | Routes                                                                                               |
| ----------------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| OpenAI Chat Completions             | Supported | `POST /v1/chat/completions`                                                                          |
| OpenAI Responses                    | Supported | `POST /v1/responses`                                                                                 |
| OpenAI Models                       | Supported | `GET /v1/models`, `GET /v1/models/{id}`                                                              |
| Google Gemini generateContent       | Supported | `POST /v1beta/models/{model}:generateContent`, `POST /v1/models/{model}:generateContent`             |
| Google Gemini streamGenerateContent | Supported | `POST /v1beta/models/{model}:streamGenerateContent`, `POST /v1/models/{model}:streamGenerateContent` |
| Google Models                       | Supported | `GET /v1beta/models`, `GET /v1beta/models/{model}`                                                   |
| Health                              | Supported | `GET /`                                                                                              |

## Choose an Edition

Both editions expose familiar OpenAI-compatible and Google-compatible APIs. They are released as separate branches, so choose the storage model that fits your deployment; neither branch is presented as an upgrade path for the other.

| | `main` | [`gemini-account-pool`](https://github.com/Guardinary/web2gem/tree/gemini-account-pool) |
| --- | --- | --- |
| Best for | Lightweight personal or single-runtime deployments. | Shared or long-running deployments that need multiple managed accounts. |
| Gemini credentials | Optional single `GEMINI_COOKIE` in runtime secrets; refreshed state stays in memory. | Multiple Gemini accounts stored persistently in D1. |
| Persistent storage | None required. | Requires `GEMINI_DB`; Docker uses the D1 HTTP binding. |
| Account management | Update the runtime secret when credentials change. | Built-in `/admin` WebUI plus `/admin/accounts` API. |
| Operations | Smallest setup and fewer moving parts. | Account selection, health state, cooldowns, refresh tracking, and redacted diagnostics. |
| Public API authentication | Optional `API_KEYS`. | Optional `API_KEYS`, with a separate single `ADMIN_KEY` for management. |

Choose `main` if you want the simplest deployment and do not need a persistent account pool. Choose `gemini-account-pool` if you want to import and manage multiple accounts without storing them directly in Worker or container environment variables.

## Core Features

| Feature                      | Description                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ready-to-use Flash models    | No authentication or configuration is required; deploy the single file to start using Flash models with no usage limits, completely free.       |
| Tool calling                 | Converts tool definitions into prompt instructions and parses DSML/XML-style tool-call output back into compatible API responses.               |
| Structured output            | Validates and canonicalizes final JSON for non-streaming structured responses; streaming structured output is rejected by default.              |
| Large context handling       | With `GEMINI_COOKIE` configured, large prompt context can be uploaded as Gemini text attachments instead of remaining entirely inline.           |
| Image generation             | Supports explicit OpenAI `image_generation` metadata for non-streaming Chat/Responses requests, plus `/v1/images/generations` and `/v1/images/edits`; a Gemini cookie is required. |
| Image input handling         | Resolves user-provided inline/base64 images through the Gemini provider path. The Worker does not fetch remote image or file URLs.                |
| Generic file attachments     | With a Gemini cookie, request-local `input_file` and inline non-image data can use Gemini Web upload references with arbitrary filenames and MIME types; persistent `/v1/files` storage is not implemented. |
| Worker and Docker deployment | Deploy the Worker bundle to Cloudflare Workers or self-host with Docker / Docker Compose; neither mode requires an account database on `main`.   |
| Upstream socket transport    | Workers prefer `cloudflare:sockets` when available; Docker uses standard `fetch`.                                                                |

## Before You Start

Choose only the settings your deployment needs:

| Goal | Required setting |
| --- | --- |
| Try supported Flash routes | No Gemini secret is required. |
| Protect a shared endpoint | Set one or more `API_KEYS`. |
| Use real Pro routing | Set `GEMINI_COOKIE`; `SAPISID` is optional and can often be derived. |
| Generate or edit images | Set `GEMINI_COOKIE`. |
| Upload large prompt context as Gemini text attachments | Set `GEMINI_COOKIE`. |
| Run behind a custom forwarding origin | Set `GEMINI_ORIGIN`. |

Gemini Web is an upstream web protocol and may change without notice. This project is best suited to personal, research, and internal use. For persistent multi-account operation, choose the [`gemini-account-pool`](https://github.com/Guardinary/web2gem/tree/gemini-account-pool) edition instead.

## API Surface

### Health

```sh
curl https://your-web2gem.example/
```

Returns service status, version, and the model IDs currently exposed by the adapter.

### OpenAI Chat Completions

```sh
curl https://your-web2gem.example/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-flash",
    "messages": [
      { "role": "user", "content": "Write a concise project summary." }
    ]
  }'
```

Set `"stream": true` to receive Server-Sent Events.

For image generation, send explicit OpenAI image-generation metadata with a non-streaming request. The Worker routes requests with either `tool_choice: { "type": "image_generation" }` or a `tools[]` entry `{ "type": "image_generation" }` through a pass-through image path. This mode uses only user-authored prompt text plus user-provided inline/existing image inputs, rejects attachments-only prompts, and returns upstream text/images as data-image or URL markdown in Chat Completions. Remote image/file URLs are not fetched. `GEMINI_COOKIE` is required for image generation, image editing, and image byte fetching.

```sh
curl https://your-web2gem.example/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-flash",
    "messages": [{ "role": "user", "content": "Generate a small blue app icon." }],
    "tool_choice": { "type": "image_generation" }
  }'
```

### OpenAI Responses

```sh
curl https://your-web2gem.example/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-flash",
    "input": "Explain what this worker does in one paragraph."
  }'
```

Responses image generation uses the same explicit metadata and returns `image_generation_call` output items with base64 `result` values when image bytes are available; URL-only image metadata is passed through as markdown output text. Streaming image generation is not supported.

### OpenAI Images API

`POST /v1/images/generations` and `POST /v1/images/edits` are supported as non-streaming image-generation routes. They do not require `tools` or `tool_choice`, but they still require `GEMINI_COOKIE`.

```sh
curl https://your-web2gem.example/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-flash",
    "prompt": "Generate a small blue app icon.",
    "response_format": "b64_json"
  }'
```

Image edits require `prompt` plus at least one local image input. JSON and multipart edit inputs can use `image`, `images`, `image_url`, or `input_image` with inline base64/data URL image bytes. Remote `http://` / `https://` image URLs are rejected and are not fetched by the Worker. Image endpoints support only `n: 1`, default `response_format` to `b64_json`, also accept `response_format: "url"` for provider URLs, and reject `stream: true`.

### Google Gemini API

```sh
curl https://your-web2gem.example/v1beta/models/gemini-3.5-flash:generateContent \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{ "text": "Return a short deployment checklist." }]
      }
    ]
  }'
```

For streaming, call `:streamGenerateContent` on the same model path.

## Models

`web2gem` exposes a fixed model map in `src/models/index.ts`.

| Model ID                         | Description                                                 |
| -------------------------------- | ----------------------------------------------------------- |
| `gemini-3.5-flash`               | Fast general-purpose model.                                 |
| `gemini-3.5-flash-thinking`      | Deep thinking mode with longer output.                      |
| `gemini-3.1-pro`                 | Pro route; requires a valid Gemini cookie for real routing. |
| `gemini-3.1-pro-enhanced`        | Experimental enhanced Pro output mode.                      |
| `gemini-auto`                    | Gemini Web auto model selection.                            |
| `gemini-3.5-flash-thinking-lite` | Dynamic thinking with adaptive depth.                       |
| `gemini-flash-lite`              | Lightweight fast model.                                     |

You can override thinking depth per request by appending `@think=N` to a known model ID, for example `gemini-3.5-flash@think=0`. Supported override values are `0`, `1`, `2`, `3`, and `4`.

## Quick Start

Both deployment modes can run without secrets. Configure optional secrets only when you need authentication or cookie-backed Gemini Web features.

### Option 1: Deploy the release single-file Worker

Download the release build artifact `worker.js` from the [Releases](https://github.com/Guardinary/web2gem/releases) page, open your Cloudflare Worker in the dashboard, and replace the Worker source with the contents of that file. In the Worker dashboard settings, add the `nodejs_compat` compatibility flag.

![Cloudflare Worker settings showing nodejs_compat](./docs/images/cloudflare-worker-settings-nodejs-compat.png)

Each release publishes these assets:

| Asset | Use |
|-------|-----|
| `worker.js` | Single-file Cloudflare Worker bundle. |
| `web2gem_<tag>_docker_linux_amd64.tar.gz` | Docker image archive for `linux/amd64`. |
| `web2gem_<tag>_docker_linux_arm64.tar.gz` | Docker image archive for `linux/arm64`. |
| `sha256sums.txt` | Checksums for the released files. |

Secrets are optional. In the Worker dashboard, open the Worker settings and add variables/secrets only for the features you need. Set `API_KEYS` when you want to protect shared access, and set `GEMINI_COOKIE` when Pro routing, large-context text attachments, or signed-in Gemini Web behavior is needed.

![Cloudflare Worker settings showing secrets](./docs/images/cloudflare-worker-settings-secrets-GEMINI_COOKIE.png)

If you build from source instead of using a release artifact, `pnpm deploy` builds `dist/worker.js` and deploys it through the checked-in `wrangler.jsonc`.

### Option 2: Deploy with Docker

Use [`.env.example`](.env.example) as the environment template and [`compose.yaml`](compose.yaml) as the Compose service definition:

```sh
cp .env.example .env
docker compose up -d
```

On PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

The provided [`compose.yaml`](compose.yaml) pulls `ghcr.io/guardinary/web2gem:latest` by default, maps `${PORT:-52389}:${PORT:-52389}`, and forwards the runtime variables from `.env`. Set `API_KEYS` in `.env` for shared deployments, and set `GEMINI_COOKIE` when Pro routing, image generation/editing, large-context text attachments, or other signed-in Gemini Web behavior is needed. To pin a specific image tag, set `WEB2GEM_IMAGE=ghcr.io/guardinary/web2gem:<tag>` in `.env`.

After the container starts, verify the local health route:

```sh
curl http://127.0.0.1:52389/
```

If you changed `PORT` in `.env`, use that host port instead. Docker deployments default `UPSTREAM_SOCKET` to `false` in [`.env.example`](.env.example) because `cloudflare:sockets` is only available in the Cloudflare Workers runtime. Other runtime variables are the same as the configuration variables listed below.

For one-off local testing without Compose, you can still build and run the image directly:

```sh
docker build -t web2gem .
docker run --rm -p 52389:52389 --env-file .env web2gem
```

Release pages also provide prebuilt Docker image archives. Download the archive matching your platform, load it, and run the tagged image:

```sh
gzip -dc web2gem_<tag>_docker_linux_amd64.tar.gz | docker load
docker run --rm -p 52389:52389 --env-file .env web2gem:<tag>
```

If the upstream Gemini Web path starts returning empty output, first check whether `GEMINI_BL` needs to be refreshed from the current Gemini Web frontend. If Cloudflare egress is rate-limited, set `GEMINI_ORIGIN` to your own forwarding service or proxy endpoint.

## Configuration

Configuration defaults live in `src/config/index.ts`. Cloudflare Worker environment variables / secrets and Docker environment variables override those defaults at runtime.

| Variable                        | Default                     | Description                                                                                                                                                                                                      |
| ------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_KEYS`                      | empty                       | Comma-separated or JSON-array API keys. Empty disables auth. Empty members, non-string members, and duplicates are rejected.                                                                                                                                                     |
| `GEMINI_COOKIE`                 | empty                       | Raw Gemini cookie string; JSON with `cookie` and optional `sapisid`; or JSON with `secure_1psid`, `secure_1psidts`, and optional `sapisid`. Needed for real Pro routing, large-context text attachments, and signed-in Gemini Web behavior. |
| `SAPISID`                       | empty                       | Optional SAPISID override. If empty, it is extracted from `GEMINI_COOKIE` when possible.                                                                                                                         |
| `GEMINI_BL`                     | bundled value               | Gemini Web build label used by upstream requests. Update if Gemini Web changes and upstream responses become empty.                                                                                              |
| `GEMINI_ORIGIN`                 | `https://gemini.google.com` | Upstream origin. Can point to your own forwarding service or proxy endpoint while preserving expected request semantics.                                                                                         |
| `UPSTREAM_SOCKET`               | `true`                      | Prefer `cloudflare:sockets` upstream transport when available.                                                                                                                                                   |
| `DEFAULT_MODEL`                 | `gemini-3.5-flash`          | Model used when a request omits `model`.                                                                                                                                                                         |
| `RETRY_ATTEMPTS`                | `3`                         | Upstream retry attempts; minimum `1`.                                                                                                                                                                            |
| `RETRY_DELAY_SEC`               | `2`                         | Delay between retry attempts; minimum `0`.                                                                                                                                                                       |
| `REQUEST_TIMEOUT_SEC`           | `180`                       | Upstream request timeout; minimum `1`.                                                                                                                                                                           |
| `REQUEST_BODY_MAX_BYTES`        | `16777216`                  | Maximum buffered JSON request-body bytes. Declared or streamed bodies above this limit are rejected with HTTP 413 before JSON parsing; multipart image edits use their attachment limit instead.                  |
| `LOG_REQUESTS`                  | `false`                     | Enable structured runtime stage logs.                                                                                                                                                                            |
| `CURRENT_INPUT_FILE_ENABLED`    | `true`                      | Enable Gemini text attachments for large prompt context.                                                                                                                                                         |
| `CURRENT_INPUT_FILE_MIN_BYTES`  | `95000`                     | Inline prompt byte threshold before text attachment handling is attempted.                                                                                                                                       |
| `CURRENT_INPUT_FILE_NAME`       | `message.txt`               | Filename used for large message context attachment.                                                                                                                                                              |
| `CURRENT_TOOLS_FILE_NAME`       | `tools.txt`                 | Filename used for large tool-definition context attachment.                                                                                                                                                      |
| `GENERIC_FILE_UPLOAD_MAX_BYTES` | `20971520`                  | Maximum bytes per request-local attachment. The preferred upload path does not send Gemini cookie or SAPISID authorization to `content-push.googleapis.com`; unavailable or failed request-local uploads are ignored with a prompt note. |

When managing a Worker through the Wrangler CLI, optional secrets can be set with:

- Set `API_KEYS` for shared deployments. If it is empty, auth is disabled.
- Set `GEMINI_COOKIE` when Pro routing, image generation/editing, large-context text attachments, or other signed-in Gemini Web behavior is needed.

```sh
wrangler secret put API_KEYS
wrangler secret put GEMINI_COOKIE
```

When `GEMINI_COOKIE` contains `__Secure-1PSID`, the Worker keeps an in-memory active cookie for the current isolate and lazily calls Google's `RotateCookies` endpoint when the cookie is stale or an authenticated upstream request fails. Refreshed cookies are kept in memory only; the Worker does not use a database for them or write them back to Worker secrets. A cold start initializes again from `GEMINI_COOKIE`.

For single-cookie deployments, use the shortest practical cookie form: `__Secure-1PSID`, `__Secure-1PSIDTS`, and optional `SAPISID`. A fresh private-browser Gemini login that is closed after extracting these values tends to be more stable than copying a full everyday-browser cookie header. If a cold start falls back to an expired `__Secure-1PSIDTS`, the first authenticated request will try to rotate it. If Google rejects that rotation or returns no updated cookie, update the `GEMINI_COOKIE` secret manually.

Short JSON cookie form:

```json
{
  "secure_1psid": "YOUR_SECURE_1PSID",
  "secure_1psidts": "YOUR_SECURE_1PSIDTS",
  "sapisid": "OPTIONAL_SAPISID"
}
```

For local development, use Wrangler environment support or pass bindings through the local Worker environment.

## Authentication

When `API_KEYS` is empty, every route except Cloudflare/Wrangler infrastructure is publicly callable. For any shared deployment, set at least one API key.

`web2gem` accepts:

- `Authorization: Bearer <key>`
- `x-api-key: <key>`
- `x-goog-api-key: <key>`

The health route `GET /` remains unauthenticated so deployment probes can work without secrets.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Pro requests fail or fall back | Confirm `GEMINI_COOKIE` contains current `__Secure-1PSID` and `__Secure-1PSIDTS` values. Update the secret if cookie rotation can no longer recover it. |
| Large-context attachment is not used | Set `GEMINI_COOKIE` and confirm `CURRENT_INPUT_FILE_ENABLED` is not disabled. |
| Shared endpoint returns 401 | Send one configured `API_KEYS` value through `Authorization: Bearer`, `x-api-key`, or `x-goog-api-key`. |
| Gemini returns empty output | Check whether `GEMINI_BL` still matches the current Gemini Web frontend. If Cloudflare egress is restricted, configure a compatible `GEMINI_ORIGIN`. |
| Docker cannot reach the service | Check the `${PORT:-52389}:${PORT:-52389}` mapping and use the configured host port. |
| You need multiple persistent accounts | Switch to [`gemini-account-pool`](https://github.com/Guardinary/web2gem/tree/gemini-account-pool) instead of placing several credentials in `GEMINI_COOKIE`. |

## Development

Authored source lives under `src/`. Do not hand-edit generated files under `dist/`.

```sh
pnpm install
pnpm typecheck
pnpm check:arch
pnpm unit
pnpm smoke
```

The build script emits two bundles:

| Bundle                | Source              | Purpose                                         |
| --------------------- | ------------------- | ----------------------------------------------- |
| `dist/worker.js`      | `src/index.ts`      | Production Worker deployed by Wrangler.         |
| `dist/worker.test.js` | `src/test-index.ts` | Local test bundle with internal helper exports. |

Maintainers create a versioned `main` release from **Actions → Versioned Release**. One run creates the version/tag and publishes GHCR plus any selected Docker Hub or Aliyun targets from the same immutable revision.

## Testing

| Command             | Description                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`    | Run TypeScript with strict compiler settings.                                                                                   |
| `pnpm check:arch`   | Enforce import boundaries and detect source dependency cycles.                                                                  |
| `pnpm unit:quick`   | Rebuild stale test bundles when needed, then run local unit checks under `tests/unit/` with Vitest.                             |
| `pnpm unit`         | Build both bundles and run local unit checks under `tests/unit/` with Vitest.                                                   |
| `pnpm coverage`     | Build an isolated coverage bundle and write Vitest V8 text, lcov, and JSON summary reports to `coverage/`.                      |
| `pnpm coverage:ci`  | Run Vitest V8 coverage with global thresholds plus source line and branch coverage gates.                                       |
| `pnpm smoke`        | Build both bundles, verify public exports, request-level routing checks, health route, and DSML tool-call parsing.              |
| `pnpm docker:smoke` | Build the Docker image, run a temporary container, and verify health, auth, and OpenAI route behavior through the Node adapter. |

Coverage builds write sourcemapped test bundles to `dist-coverage/` so normal `dist/` builds and coverage runs do not share generated artifacts. Vitest discovers `tests/unit/*.test.mjs` wrappers for `pnpm unit`; shared case lists live in `tests/unit/*.cases.mjs`, use Vitest-backed assertions, and coverage uses Vitest's V8 provider against the isolated test bundle. `pnpm coverage` and `pnpm coverage:ci` use a Node runner so environment variables are handled consistently across Windows and Unix shells. `pnpm coverage:ci` also reads `coverage/coverage-summary.json` through `scripts/check-coverage.mjs` to catch regressions in key source directories and selected high-risk branch paths.

Recommended pre-commit gate:

```sh
pnpm typecheck
pnpm check:arch
pnpm unit
pnpm coverage:ci
pnpm smoke
# Optional when Docker is available:
pnpm docker:smoke
```

## Project Structure

```text
.
├── scripts/                 # Build, architecture, unit, and smoke scripts
├── src/
│   ├── completion/          # Provider-neutral completion runtime
│   ├── config/              # Runtime configuration parsing
│   ├── gemini/              # Gemini Web client, transport, uploads, provider adapter
│   ├── http/                # HTTP boundary, OpenAI and Google protocol adapters
│   ├── models/              # Exposed model map and model resolution
│   ├── promptcompat/        # API request shapes to Gemini prompt text
│   ├── shared/              # Provider-neutral utilities
│   ├── toolcall/            # Tool-call prompt, policy, parser, formatter
│   └── toolstream/          # Streamed tool-call detection state
├── tests/unit/              # Local unit checks
├── wrangler.jsonc           # Cloudflare Worker deployment config
└── package.json             # Node scripts and dev dependencies
```

## Security Notice

This project adapts Gemini Web behavior and depends on upstream web protocol details that can change without notice. Use it for personal, research, or internal validation scenarios, and review the terms and risk profile of the upstream service before deploying it for shared use.

Never commit Gemini cookies or API keys. Store secrets in Cloudflare Worker secrets, Docker environment management, or another deployment-secret mechanism.

## Acknowledgements

[![LinuxDo](https://img.shields.io/badge/Community-LinuxDo-blue?style=for-the-badge)](https://linux.do/)

## License

[MIT](LICENSE)
