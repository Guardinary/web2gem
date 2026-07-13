# web2gem

[English](README.md) | [简体中文](README.zh.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Guardinary/web2gem/tree/gemini-account-pool)

Persistent Gemini Web account-pool gateway with OpenAI-compatible and Google-compatible APIs. Deploy it on Cloudflare Workers or run it with Docker, then manage multiple Gemini accounts from one admin console.

> This is the independently released `gemini-account-pool` branch. It uses D1-backed persistent storage and is not the same deployment model as `main`.

[Deploy to Cloudflare](#option-1-deploy-to-cloudflare-workers) · [Deploy with Docker](#option-2-deploy-with-docker) · [Import accounts](#account-pool-management) · [API examples](#api-surface)

## Contents

- [web2gem](#web2gem)
  - [Contents](#contents)
  - [Overview](#overview)
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
    - [Option 1: Deploy to Cloudflare Workers](#option-1-deploy-to-cloudflare-workers)
    - [Option 2: Deploy with Docker](#option-2-deploy-with-docker)
  - [Differences from the main branch](#differences-from-the-main-branch)
  - [Configuration](#configuration)
  - [Account Pool Management](#account-pool-management)
  - [Authentication](#authentication)
  - [Troubleshooting](#troubleshooting)
  - [Development](#development)
  - [Testing](#testing)
  - [Project Structure](#project-structure)
  - [Security Notice](#security-notice)
  - [Acknowledgements](#acknowledgements)
  - [License](#license)

## Overview

`web2gem` lets OpenAI-compatible and Google Gemini-compatible clients use Gemini Web through a familiar HTTP API. This branch adds a persistent account pool: import your own Gemini Web accounts once, and the service stores their operational state in D1, selects an available account for each request, and tracks failures, cooldowns, and refresh results.

A typical setup is:

1. Deploy the Worker or Docker service.
2. Configure D1 and one `ADMIN_KEY`.
3. Open `/admin` and import one or more Gemini accounts.
4. Optionally configure `API_KEYS` for client access.
5. Point your OpenAI-compatible or Gemini-compatible client at the deployed URL.

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

## Core Features

| Feature                      | Description                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent account pool      | Store multiple Gemini Web accounts and their operational state in D1 instead of placing one account cookie directly in the runtime environment.  |
| Built-in admin console       | Import, inspect, filter, enable, disable, refresh, check, edit, and delete accounts from `/admin`.                                                 |
| Automatic account selection  | Select an eligible account for each generation request while avoiding disabled, cooling-down, or otherwise unavailable accounts.                 |
| Account health tracking      | Record availability, cooldowns, failure reasons, refresh state, and request outcomes without exposing stored session credentials.                |
| Tool calling                 | Converts tool definitions into prompt instructions and parses DSML/XML-style tool-call output back into compatible API responses.                |
| Structured output            | Validates and canonicalizes final JSON for non-streaming structured responses; streaming structured output is rejected by default.               |
| Large context handling       | Large prompt context can be uploaded as Gemini text attachments through the account selected from the pool instead of remaining entirely inline. |
| Image generation             | Supports explicit OpenAI `image_generation` metadata for non-streaming Chat/Responses requests, plus `/v1/images/generations` and `/v1/images/edits`, using the selected account. |
| Image input handling         | Resolves user-provided inline/base64 images through the selected Gemini account. The Worker does not fetch remote image or file URLs.             |
| Generic file attachments     | Request-local `input_file` and inline non-image data can use Gemini Web upload references with arbitrary filenames and MIME types; persistent `/v1/files` storage is not implemented. |
| Worker and Docker deployment | Run on Cloudflare Workers with a native D1 binding or use Docker with the Cloudflare D1 HTTP binding.                                              |
| Upstream socket transport    | Workers prefer `cloudflare:sockets` when available; Docker uses standard `fetch`.                                                                 |
| Fail-closed operation        | Missing storage, unavailable accounts, invalid configuration, and admin failures return sanitized errors instead of falling back to embedded credentials. |

## Before You Start

For the full account-backed feature set, you need:

- one or more Gemini Web accounts that you are authorized to use;
- a Cloudflare D1 database;
- one strong `ADMIN_KEY` for the account console;
- for Docker, a Cloudflare account ID, D1 database ID, and API token;
- optionally, one or more `API_KEYS` if the public endpoint will be shared.

Short text-only requests can use Gemini Web anonymously without `GEMINI_DB`. Requests use anonymous upstream first when they have no file references or image operation, the rendered prompt is at most `CURRENT_INPUT_FILE_MIN_BYTES` (95,000 UTF-8 bytes by default), and the model is not a Pro model. Pro, long-context, attachment, image-generation, and image-edit requests require `GEMINI_DB` and a usable account. Gemini Web is an upstream web protocol and may change without notice; this project is best suited to personal, research, and internal use.

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

For image generation, send explicit OpenAI image-generation metadata with a non-streaming request. The Worker routes requests with either `tool_choice: { "type": "image_generation" }` or a `tools[]` entry `{ "type": "image_generation" }` through a pass-through image path. This mode uses only user-authored prompt text plus user-provided inline/existing image inputs, rejects attachments-only prompts, and returns upstream text/images as data-image or URL markdown in Chat Completions. Remote image/file URLs are not fetched. A configured D1-backed Gemini account pool is required for image generation, image editing, and image byte fetching.

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

`POST /v1/images/generations` and `POST /v1/images/edits` are supported as non-streaming image-generation routes. They do not require `tools` or `tool_choice`, but they still require the configured Gemini account pool.

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
| `gemini-3.1-pro`                 | Pro route; requires a usable account in the configured pool. |
| `gemini-3.1-pro-enhanced`        | Experimental enhanced Pro output mode.                      |
| `gemini-auto`                    | Gemini Web auto model selection.                            |
| `gemini-3.5-flash-thinking-lite` | Dynamic thinking with adaptive depth.                       |
| `gemini-flash-lite`              | Lightweight fast model.                                     |

You can override thinking depth per request by appending `@think=N` to a known model ID, for example `gemini-3.5-flash@think=0`. Supported override values are `0`, `1`, `2`, `3`, and `4`.

## Quick Start

Anonymous-eligible text generation works without `GEMINI_DB`. Configure `GEMINI_DB`, import at least one account, and set `ADMIN_KEY` when you need Pro models, long context, attachments, image generation/editing, or account fallback. `API_KEYS` is optional but recommended for any shared endpoint.

### Option 1: Deploy to Cloudflare Workers

#### Recommended: deploy button (first deployment only)

For source-based one-click deployment to Cloudflare Workers, use the deploy button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Guardinary/web2gem/tree/gemini-account-pool)

The button creates a deployment repository and Worker, provisions the `GEMINI_DB` D1 database from the draft binding in `wrangler.jsonc`, builds the Worker, runs `wrangler d1 migrations apply GEMINI_DB --remote` through the deploy script, then deploys the Worker. During setup, enter `ADMIN_KEY`; `API_KEYS` is optional. After deployment, open the admin UI and import your own Gemini account values.

The deploy form shows non-secret Worker settings from `wrangler.jsonc` `vars` in plain text. Only secrets from [`.env.example`](.env.example) and [`.dev.vars.example`](.dev.vars.example), currently `API_KEYS` and `ADMIN_KEY`, are hidden.

Do not use the Deploy button to upgrade an existing deployment. Running it again creates another project instead of updating the existing Worker.

#### Manual updates for the deployment repository

The updater follows the Renewlet-style deployment-mirror model and intentionally uses only `workflow_dispatch`; it does not run on a schedule. When you want to upgrade, open the repository created by Cloudflare and check whether **Actions → Sync upstream** or `.github/workflows/sync-upstream.yml` exists.

If the workflow exists, complete this one-time setup:

1. Open **Actions** and enable workflows if GitHub asks.
2. Open **Settings → Actions → General → Workflow permissions** and select **Read and write permissions**. Organization policy may require an administrator to allow this.
3. Open **Actions → Sync upstream**, select **Run workflow**, and confirm the run.

For each future upgrade, repeat only step 3. The workflow mirrors `Guardinary/web2gem` `gemini-account-pool` into the deployment repository while preserving its `.github/workflows` and `wrangler.jsonc`. It pushes only when application files changed, and the connected Cloudflare Workers Build can deploy that push to the existing Worker.

If Cloudflare did not copy the workflow, install it once in the generated repository:

1. Open the canonical [`sync-upstream.yml`](https://github.com/Guardinary/web2gem/blob/gemini-account-pool/.github/workflows/sync-upstream.yml) and copy its contents.
2. In the generated repository, choose **Add file → Create new file**, enter `.github/workflows/sync-upstream.yml`, paste the contents, and commit the file.
3. Enable Actions and read/write workflow permissions, then run **Sync upstream** manually.

Treat the generated repository as a deployment mirror: configure secrets and bindings through Cloudflare, and avoid editing application source because the next sync replaces it. Review upstream `wrangler.jsonc` changes separately because the deployment copy is intentionally preserved.

The canonical D1 binding omits `database_id`. Do not add a D1 database ID to GitHub Secrets; only Worker secrets such as `ADMIN_KEY` and optional `API_KEYS` belong in the Cloudflare secret flow. If synchronization succeeds but deployment fails, inspect the Worker's Cloudflare **Builds** logs. Permission failures usually mean Actions is disabled, workflow permissions are read-only, or branch protection rejects the updater push.

#### Manual: release bundle

Download the release build artifact `worker.js` from the [Releases](https://github.com/Guardinary/web2gem/releases) page, open your Cloudflare Worker in the dashboard, and replace the Worker source with the contents of that file. In the Worker dashboard settings, add the `nodejs_compat` compatibility flag.

![Cloudflare Worker settings showing nodejs_compat](./docs/images/cloudflare-worker-settings-nodejs-compat.png)

Each release publishes these assets:

| Asset | Use |
|-------|-----|
| `worker.js` | Single-file Cloudflare Worker bundle. |
| `web2gem_<tag>_docker_linux_amd64.tar.gz` | Docker image archive for `linux/amd64`. |
| `web2gem_<tag>_docker_linux_arm64.tar.gz` | Docker image archive for `linux/arm64`. |
| `sha256sums.txt` | Checksums for the released files. |

For a manual deployment, also create and bind `GEMINI_DB`, apply the included schema, and set `ADMIN_KEY` before opening `/admin`. Set `API_KEYS` when you want to protect shared client access. See [Account Pool Management](#account-pool-management) for the D1 command and import flow.

If you build from source instead of using a release artifact, `pnpm deploy` builds `dist/worker.js`, applies D1 migrations to the `GEMINI_DB` binding, and deploys through the checked-in `wrangler.jsonc`.

### Option 2: Deploy with Docker

> **Currently unavailable:** `gemini-account-pool` has not published its first Docker image or release archives yet. The default `ghcr.io/guardinary/web2gem:latest` image currently belongs to the `main` edition, so the Compose and prebuilt-image instructions below must not be used for this branch until an account-pool release is published. Use the Cloudflare Workers deployment for now.

Use [`.env.docker.example`](.env.docker.example) as the environment template and [`compose.yaml`](compose.yaml) as the Compose service definition:

```sh
cp .env.docker.example .env
docker compose up -d
```

On PowerShell, use `Copy-Item .env.docker.example .env` instead of `cp`.

The provided [`compose.yaml`](compose.yaml) pulls `ghcr.io/guardinary/web2gem:latest` by default, maps `${PORT:-52389}:${PORT:-52389}`, and forwards the runtime variables from `.env`. Set `ADMIN_KEY`, plus `D1_ACCOUNT_ID`, `D1_DATABASE_ID`, and `D1_API_TOKEN`, so Docker can manage accounts and inject the required `GEMINI_DB` binding. Set `API_KEYS` for shared deployments. To pin a specific image tag, set `WEB2GEM_IMAGE=ghcr.io/guardinary/web2gem:<tag>` in `.env`.

After the container starts, verify the local health route:

```sh
curl http://127.0.0.1:52389/
```

Then open `http://127.0.0.1:52389/admin`, enter `ADMIN_KEY`, and import your first account.

If you changed `PORT` in `.env`, use that host port instead. Docker deployments default `UPSTREAM_SOCKET` to `false` in [`.env.docker.example`](.env.docker.example) because `cloudflare:sockets` is only available in the Cloudflare Workers runtime. Other runtime variables are the same as the configuration variables listed below.

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

## Differences from the main branch

`gemini-account-pool` is the persistent-storage edition of `web2gem`. It is released independently from `main`; the shared OpenAI-compatible and Google-compatible generation routes remain familiar, while account provisioning and operations use a different model.

Maintainers publish this branch through the single `Versioned Release` workflow. Every release publishes GitHub assets and GHCR from the captured account-pool revision, with optional Docker Hub and Aliyun publication in the same multi-platform image build.

| Area | `main` | `gemini-account-pool` |
| --- | --- | --- |
| Gemini credentials | Reads a directly configured Gemini cookie for the current runtime. | Stores multiple Gemini accounts in D1 and selects an available account for each generation request. |
| Persistence | Does not provide a persistent Gemini account store. | Persists account metadata, health state, cooldowns, refresh state, and coordination locks in `GEMINI_DB`. |
| Administration | No persistent account-pool console is required. | Provides the `/admin` WebUI and resource-oriented `/admin/accounts` API, protected by one `ADMIN_KEY`. |
| Deployment requirements | Can run without an account database. | Anonymous-eligible short text works without D1. Pro, long-context, attachment, image-generation, image-edit, and account-fallback paths require a configured D1 binding and a usable imported account. |
| Docker integration | Uses the standard Docker adapter and runtime environment. | Adds the D1 HTTP binding through `D1_ACCOUNT_ID`, `D1_DATABASE_ID`, and `D1_API_TOKEN`. |
| Runtime validation | Uses the main-branch configuration contract. | Applies strict boolean, integer, origin, filename, and `API_KEYS` validation. `ADMIN_KEY` is read as one ordinary string setting. Invalid value types fail with sanitized diagnostics. |
| Admin API | Not applicable to a persistent pool. | Uses `PATCH` / `DELETE /admin/accounts/:id` and `POST /admin/accounts/:id/refresh` or `/check`; public `x-api-key` credentials never authorize admin operations. |

The production bundle also keeps Worker and Docker routing behind one application boundary and includes representative performance gates for streaming, socket parsing, and structured-output paths. These are branch-specific implementation differences and do not imply equivalent changes to `main`.

## Configuration

Configuration defaults live in `src/config/index.ts`. Cloudflare Worker environment variables / secrets and Docker environment variables override those defaults at runtime.

| Variable                        | Default                     | Description                                                                                                                                                                                                      |
| ------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_KEYS`                      | empty                       | Comma-separated or JSON-array API keys. Empty disables auth. Empty members, non-string members, and duplicates are rejected.                                                                                   |
| `ADMIN_KEY`                     | empty                       | Single admin key for account-pool management. Public `API_KEYS` do not authorize admin account mutation.                                                                                                    |
| `D1_ACCOUNT_ID`                 | empty                       | Docker-only Cloudflare account ID for the D1 HTTP binding. Set together with `D1_DATABASE_ID` and `D1_API_TOKEN`; partial D1 HTTP config fails startup.                                                          |
| `D1_DATABASE_ID`                | empty                       | Docker-only Cloudflare D1 database ID for the injected `GEMINI_DB` binding.                                                                                                                                      |
| `D1_API_TOKEN`                  | empty                       | Docker-only Cloudflare API token allowed to query the D1 database. Adapter errors redact this token and SQL bind values.                                                                                         |
| `GEMINI_BL`                     | bundled value               | Gemini Web build label used by upstream requests. Update if Gemini Web changes and upstream responses become empty.                                                                                              |
| `GEMINI_ORIGIN`                 | `https://gemini.google.com` | Absolute HTTP(S) upstream origin without credentials, path, query, or fragment. Can point to your own forwarding service or proxy origin.                                                                        |
| `UPSTREAM_SOCKET`               | `true`                      | Prefer `cloudflare:sockets` upstream transport when available.                                                                                                                                                   |
| `DEFAULT_MODEL`                 | `gemini-3.5-flash`          | Model used when a request omits `model`.                                                                                                                                                                         |
| `RETRY_ATTEMPTS`                | `3`                         | Upstream retry attempts; strict integer from `1` to `10`.                                                                                                                                                        |
| `RETRY_DELAY_SEC`               | `2`                         | Delay between retry attempts; strict integer from `0` to `60`.                                                                                                                                                   |
| `REQUEST_TIMEOUT_SEC`           | `180`                       | Upstream request timeout; strict integer from `1` to `3600`.                                                                                                                                                     |
| `REQUEST_BODY_MAX_BYTES`        | Worker: `16777216`; Docker: `67108864` | Maximum buffered generation JSON body, including inline Base64 data. Values from `1` to `104857600` are accepted. Multipart image edits remain independently governed by `GENERIC_FILE_UPLOAD_MAX_BYTES` plus form overhead. |
| `LOG_REQUESTS`                  | `false`                     | Enable structured runtime stage logs.                                                                                                                                                                            |
| `CURRENT_INPUT_FILE_ENABLED`    | `true`                      | Enable Gemini text attachments for large prompt context.                                                                                                                                                         |
| `CURRENT_INPUT_FILE_MIN_BYTES`  | `95000`                     | Inline prompt byte threshold before text attachment handling is attempted.                                                                                                                                       |
| `CURRENT_INPUT_FILE_NAME`       | `message.txt`               | Filename used for large message context attachment.                                                                                                                                                              |
| `CURRENT_TOOLS_FILE_NAME`       | `tools.txt`                 | Filename used for large tool-definition context attachment.                                                                                                                                                      |
| `GENERIC_FILE_UPLOAD_MAX_BYTES` | `20971520`                  | Maximum bytes per request-local attachment. The preferred upload path does not send Gemini cookie or SAPISID authorization to `content-push.googleapis.com`; unavailable or failed request-local uploads are ignored with a prompt note. |

When managing a Worker through the Wrangler CLI, configure secrets with:

- Set `API_KEYS` for shared deployments. If it is empty, auth is disabled.
- Set `ADMIN_KEY` before using account-pool admin endpoints. Admin endpoints do not become public when this is missing.
- Bind the D1 database as `GEMINI_DB` and import Gemini accounts before serving account-required traffic such as Pro, long-context, attachment, or image requests.

```sh
wrangler secret put API_KEYS
wrangler secret put ADMIN_KEY
```

## Account Pool Management

The easiest way to get started is the built-in WebUI:

1. Open `https://your-worker.example/admin`.
2. Enter the configured `ADMIN_KEY` and choose session or local browser storage.
3. Import the bare values of `__Secure-1PSID` and `__Secure-1PSIDTS`.
4. Confirm the account appears as enabled and available.
5. Send a generation request through any supported API route.

Use a fresh or dedicated Gemini browser session when possible. Do not paste a full Cookie header, a browser cookie export, cookie names, equals signs, semicolons, or unrelated access tokens. The admin responses and account list are redacted and never return the stored session credentials.

This branch uses hybrid upstream routing. Eligible short text requests try anonymous Gemini Web first without reading D1. If anonymous generation fails before output, the provider selects one account through the existing least-in-flight and round-robin pool and retries once. Pro, long-context, attachment, image-generation, and image-edit requests go directly to the account pool. Missing authenticated-session capability returns HTTP 422 with `gemini_authenticated_session_required` and a machine-readable `reason`; an empty configured pool returns HTTP 503 with `no_available_gemini_account`, while a failed anonymous request keeps its original error when no fallback account exists.

For Workers, create a D1 database, apply [`migrations/0001_gemini_accounts.sql`](migrations/0001_gemini_accounts.sql), and bind it as `GEMINI_DB` in `wrangler.jsonc` or through your Cloudflare dashboard configuration. The schema creates structured `gemini_accounts`, `gemini_pool_meta`, and `gemini_account_locks` tables rather than storing account state as one JSON blob.

For a new D1 database, apply the migration once:

```sh
wrangler d1 execute <database-name> --file migrations/0001_gemini_accounts.sql --remote
```

For Docker, set all of `D1_ACCOUNT_ID`, `D1_DATABASE_ID`, and `D1_API_TOKEN` in `.env`. When all three are present, `scripts/docker-server.mjs` injects a D1-compatible `GEMINI_DB` binding backed by Cloudflare's D1 HTTP API. If only some are present, startup fails with a configuration error.

Worker account imports accept at most 40 accounts per admin request so native D1 work stays below the Workers Free per-invocation query limit. For larger imports, the built-in `/admin` UI first tries the complete batch and, only after the Worker returns the stable limit error, automatically retries sequentially in groups of 40 and aggregates the results. Direct admin API clients must split their own requests. Docker does not apply this account-count ceiling, so its initial UI request remains a single request; Docker imports are bounded by the shared 256 KiB admin request-body limit.

For automation, use the admin API under `/admin/accounts`. Requests require the configured `ADMIN_KEY` through `Authorization: Bearer <key>` or `X-Admin-Key`. Public `API_KEYS` and query-string `key` do not authorize these routes.

Default Gemini import accepts only bare cookie values:

```sh
curl -X POST "https://your-worker.example/admin/accounts" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider":"gemini","accounts":[{"__Secure-1PSID":"<value-only>","__Secure-1PSIDTS":"<value-only>","label":"primary"}]}'
```

Duplicate imports are skipped safely. List responses are paginated with `limit` and `cursor`, support `status`, `enabled`, `q`, `category`, `cooldown`, and `source` filters, and expose only redacted metadata.

The admin API also exposes aggregate counts for the current filter set:

```sh
curl "https://your-worker.example/admin/accounts/stats?status=active&enabled=true" \
  -H "Authorization: Bearer $ADMIN_KEY"
```

Stats responses include `total`, `available`, `needsAttention`, `disabled`, `refreshable`, `cooling`, `psidOnly`, `successCount`, and `failureCount`.

Explicit diagnostics are admin-only:

```sh
curl -X POST "https://your-worker.example/admin/accounts/<account-id>/refresh" \
  -H "Authorization: Bearer $ADMIN_KEY"
```

Refresh/check responses include countable fields such as `checked`, `skipped`, `refreshed`, `unchanged`, `failed`, `errors`, `results`, and sanitized `items`. Startup, health, and public model-list routes do not select accounts, call `/app`, rotate cookies, or probe Google.

When importing accounts, use only the shortest supported credential form: `__Secure-1PSID` and `__Secure-1PSIDTS`. A fresh private-browser Gemini login that is closed after extracting these values tends to be more stable than copying a full everyday-browser cookie header.

For local development, use Wrangler environment support or pass bindings through the local Worker environment.

## Authentication

When `API_KEYS` is empty, public generation routes are callable without client authentication. Admin routes still require `ADMIN_KEY`. For any shared deployment, set at least one API key.

`web2gem` accepts:

- `Authorization: Bearer <key>`
- `x-api-key: <key>`
- `x-goog-api-key: <key>`

The health route `GET /` remains unauthenticated so deployment probes can work without secrets.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `gemini_authenticated_session_required` | A Pro, long-context, attachment, or image request needs an authenticated Gemini session that this deployment has not configured. Inspect `reason`, then add the Worker D1 binding or all three Docker D1 credentials. |
| `no_available_gemini_account` | Direct account-required work found no selectable account. Open `/admin`; import an account, enable it, and check whether it is cooling down or needs refreshed credentials. |
| `invalid_runtime_config` | Review environment values. Booleans must be `true`/`false`, integers must be in range, and `ADMIN_KEY` must be one non-placeholder string. |
| Admin page returns 401 | Confirm the value sent by the WebUI matches `ADMIN_KEY`; public `API_KEYS` cannot authorize admin operations. |
| Docker exits before listening | Set `D1_ACCOUNT_ID`, `D1_DATABASE_ID`, and `D1_API_TOKEN` together, then inspect the container logs for the sanitized startup error. |
| Gemini returns empty output | Check whether `GEMINI_BL` still matches the current Gemini Web frontend. If Cloudflare egress is restricted, configure a compatible `GEMINI_ORIGIN`. |
| Image edit is rejected | Use inline base64/data URL or multipart image data. Remote `http://` and `https://` image URLs are intentionally not fetched. |

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
