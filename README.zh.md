# web2gem

[English](README.md) | [简体中文](README.zh.md)

面向 Gemini Web 的 OpenAI 兼容和 Google Gemini 兼容 HTTP 适配器，可部署到 Cloudflare Workers，也可作为 Docker 服务自托管。零成本, 跨平台, 单文件。

TypeScript 代码位于 `src/`，本地质量检查脚本位于 `scripts/`，`dist/worker.js` 由 `pnpm build` 生成并用于 Wrangler 部署，`scripts/docker-server.mjs` 提供 Docker HTTP 适配层。

## 目录

- [web2gem](#web2gem)
  - [目录](#目录)
  - [概览](#概览)
  - [核心功能](#核心功能)
  - [API 接口](#api-接口)
    - [健康检查](#健康检查)
    - [OpenAI Chat Completions](#openai-chat-completions)
    - [OpenAI Responses](#openai-responses)
    - [Google Gemini API](#google-gemini-api)
  - [模型](#模型)
  - [快速开始](#快速开始)
    - [方式一：通过 Release 单文件 Worker 产物部署](#方式一通过-release-单文件-worker-产物部署)
    - [方式二：通过 Docker 部署](#方式二通过-docker-部署)
  - [配置](#配置)
  - [认证](#认证)
  - [开发](#开发)
  - [测试](#测试)
  - [项目结构](#项目结构)
  - [安全提示](#安全提示)
  - [致谢](#致谢)
  - [许可证](#许可证)

## 概览

`web2gem` 将常见 OpenAI 和 Google Gemini API 请求形状转换为 Gemini Web 请求。它既可以运行在 Cloudflare Workers 上，也可以作为 Docker 托管的 Node 服务运行。在 Workers 上，当常规 `fetch` 路径受到限流时，可以使用 `cloudflare:sockets` 作为上游 HTTP 传输方式；Docker 部署默认使用标准 `fetch` 传输。

主要兼容目标如下：

| 接口                                | 状态 | 路由                                                                                                 |
| ----------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| OpenAI Chat Completions             | 支持 | `POST /v1/chat/completions`                                                                          |
| OpenAI Responses                    | 支持 | `POST /v1/responses`                                                                                 |
| OpenAI Models                       | 支持 | `GET /v1/models`, `GET /v1/models/{id}`                                                              |
| Google Gemini generateContent       | 支持 | `POST /v1beta/models/{model}:generateContent`, `POST /v1/models/{model}:generateContent`             |
| Google Gemini streamGenerateContent | 支持 | `POST /v1beta/models/{model}:streamGenerateContent`, `POST /v1/models/{model}:streamGenerateContent` |
| Google Models                       | 支持 | `GET /v1beta/models`, `GET /v1beta/models/{model}`                                                   |
| 健康检查                            | 支持 | `GET /`                                                                                              |

## 核心功能

| 功能                  | 说明                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| Flash 模型开箱即用   | 无需任何鉴权，也无需任何配置，部署单文件即可开始使用flash模型，无用量限制，完全免费。                          |
| OpenAI 兼容 API       | Chat Completions 和 Responses 端点，文本/工具调用流程支持流式输出。                                             |
| Google 兼容 API       | 面向 Gemini 风格客户端的 `generateContent` 和 `streamGenerateContent` 路由。                                   |
| 工具调用              | 将工具定义转换为提示词指令，并把 DSML/XML 风格工具调用输出解析回 API 响应。                                    |
| 结构化输出            | 对非流式结构化响应进行最终 JSON 校验和规范化；默认拒绝流式结构化输出。                                         |
| 大上下文处理          | 在配置 Gemini cookie 时，可将大段提示上下文作为 Gemini 文本附件上传。                                          |
| 生图                  | 支持非流式 Chat/Responses 请求中的显式 OpenAI `image_generation` 元数据，以及 `/v1/images/generations`、`/v1/images/edits`。 |
| 图片输入处理          | 通过 Gemini provider 路径解析用户提供的内联/base64 图片输入；Worker 不抓取远程图片或文件 URL。                 |
| 通用文件附件          | 请求内 `input_file` 和非图片内联数据可通过 Gemini Web 上传引用传入，支持任意文件名和 MIME；不实现 `/v1/files` 持久文件服务。 |
| Worker 和 Docker 部署 | 可通过 Wrangler 部署到 Cloudflare Workers，也可用 Docker / Docker Compose 自托管。                             |
| 上游 socket 传输      | Workers 上默认使用 `cloudflare:sockets`；Docker 默认使用标准 `fetch` 传输，除非运行时提供兼容的 sockets 能力。 |
| CORS 和 API key 保护  | 处理浏览器预检请求，并支持可选的 bearer/API-key 认证。                                                         |
| 本地测试 bundle       | 构建独立的 `dist/worker.test.js`，让单元测试可检查内部实现，同时不把测试辅助导出泄漏到生产 bundle。            |

## API 接口

### 健康检查

```sh
curl https://your-web2gem.example/
```

返回服务状态、版本号，以及当前适配器暴露的模型 ID。

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

设置 `"stream": true` 可接收 Server-Sent Events。

生图请求必须使用显式 OpenAI image-generation 元数据。`tool_choice: { "type": "image_generation" }` 或 `tools[]` 中的 `{ "type": "image_generation" }` 会进入 pass-through 生图路径。该模式只使用用户编写的提示词文本和用户提供的内联/已有图片输入；仅有附件没有提示词会被拒绝。Chat Completions 会以 data-image 或 URL markdown 透传上游文本/图片。Worker 不抓取远程图片或文件 URL。生图、图像编辑和图片字节获取都需要配置 `GEMINI_COOKIE`。

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

Responses 生图使用相同的显式元数据；当图片字节可用时，会返回带 base64 `result` 的 `image_generation_call` output item；只有 URL metadata 时会以 markdown output text 透传。流式生图暂不支持。

### OpenAI Images API

`POST /v1/images/generations` 和 `POST /v1/images/edits` 作为非流式生图路由提供兼容。它们不需要 `tools` 或 `tool_choice`，但仍然需要配置 `GEMINI_COOKIE`。

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

图片编辑需要同时提供 `prompt` 和至少一个本地图片输入。JSON 和 multipart 编辑输入可使用 `image`、`images`、`image_url` 或 `input_image`，图片内容必须是内联 base64/data URL 字节。远程 `http://` / `https://` 图片 URL 会被拒绝，Worker 不会抓取。图片端点只支持 `n: 1`，`response_format` 默认是 `b64_json`，也接受 `response_format: "url"` 以返回 provider URL，并且拒绝 `stream: true`。

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

流式输出时，在相同模型路径上调用 `:streamGenerateContent`。

## 模型

`web2gem` 在 `src/models/index.ts` 中暴露固定模型映射。

| 模型 ID                          | 说明                                       |
| -------------------------------- | ------------------------------------------ |
| `gemini-3.5-flash`               | 快速通用模型。                             |
| `gemini-3.5-flash-thinking`      | 深度思考模式，输出更长。                   |
| `gemini-3.1-pro`                 | Pro 路由；真实路由需要有效 Gemini cookie。 |
| `gemini-3.1-pro-enhanced`        | 实验性的增强 Pro 输出模式。                |
| `gemini-auto`                    | Gemini Web 自动模型选择。                  |
| `gemini-3.5-flash-thinking-lite` | 动态思考，自适应深度。                     |
| `gemini-flash-lite`              | 轻量快速模型。                             |

可以在请求模型 ID 后追加 `@think=N` 覆盖思考深度，例如 `gemini-3.5-flash@think=0`。支持的覆盖值为 `0`、`1`、`2`、`3`、`4`。

## 快速开始

两种部署方式都可以不设置 secrets。只有需要认证或依赖 cookie 的 Gemini Web 能力时，才需要配置可选 secrets。

### 方式一：通过 Release 单文件 Worker 产物部署

从项目 [Releases](https://github.com/Guardinary/web2gem/releases) 页面下载构建产物 `worker.js`，在 Cloudflare Worker 控制台打开你的 Worker，将 Worker 源码替换为该文件内容。然后在 Worker 控制台设置中添加 `nodejs_compat` 兼容性标记。

![Cloudflare Worker 设置中的 nodejs_compat 兼容性标记](./docs/images/cloudflare-worker-settings-nodejs-compat.png)

每个 Release 会发布这些文件：

| 文件 | 用途 |
|------|------|
| `worker.js` | 单文件 Cloudflare Worker bundle。 |
| `web2gem_<tag>_docker_linux_amd64.tar.gz` | `linux/amd64` Docker 镜像归档。 |
| `web2gem_<tag>_docker_linux_arm64.tar.gz` | `linux/arm64` Docker 镜像归档。 |
| `sha256sums.txt` | 发布文件校验和。 |

Secrets 是可选项。在 Worker 控制台中打开该 Worker 的设置页，只为需要的功能添加变量或 Secrets。需要保护共享访问时设置 `API_KEYS`；需要 Pro 路由、大上下文文本附件或已登录 Gemini Web 行为时设置 `GEMINI_COOKIE`。

![Cloudflare Worker 设置中的 secrets](./docs/images/cloudflare-worker-settings-secrets-GEMINI_COOKIE.png)

如果不使用 Release 产物、而是从源码构建，`pnpm deploy` 会构建 `dist/worker.js`，并通过仓库内的 `wrangler.jsonc` 部署。

### 方式二：通过 Docker 部署

使用 [`.env.example`](.env.example) 作为环境变量模板，使用 [`compose.yaml`](compose.yaml) 作为 Compose 服务定义：

```sh
cp .env.example .env
docker compose up -d
```

仓库提供的 [`compose.yaml`](compose.yaml) 默认拉取 `ghcr.io/guardinary/web2gem:latest`，映射 `${PORT:-52389}:${PORT:-52389}`，并从 `.env` 传入运行时变量。共享部署时在 `.env` 中设置 `API_KEYS`；需要 Pro 路由、大上下文文本附件或已登录 Gemini Web 行为时设置 `GEMINI_COOKIE`。如需固定镜像版本，可在 `.env` 中设置 `WEB2GEM_IMAGE=ghcr.io/guardinary/web2gem:<tag>`。

容器启动后，可验证本地健康检查路由：

```sh
curl http://127.0.0.1:52389/
```

如果你在 `.env` 中修改了 `PORT`，请使用修改后的宿主机端口。Docker 部署在 [`.env.example`](.env.example) 中默认将 `UPSTREAM_SOCKET` 设为 `false`，因为 `cloudflare:sockets` 只在 Cloudflare Workers 运行时可用。其他运行时变量与下方配置表相同。

如果只是临时本地测试，也可以不用 Compose，直接构建并运行镜像：

```sh
docker build -t web2gem .
docker run --rm -p 52389:52389 --env-file .env web2gem
```

Release 页面也提供预构建 Docker 镜像归档。下载与你的平台匹配的归档，加载后运行对应 tag：

```sh
gzip -dc web2gem_<tag>_docker_linux_amd64.tar.gz | docker load
docker run --rm -p 52389:52389 --env-file .env web2gem:<tag>
```

如果上游 Gemini Web 路径开始返回空输出，先检查 `GEMINI_BL` 是否需要从当前 Gemini Web 前端刷新。如果 Cloudflare 出口请求被限流，可以把 `GEMINI_ORIGIN` 设置成你自己的转发服务或代理地址。

## 配置

配置默认值位于 `src/config/index.ts`。Cloudflare Worker 环境变量 / secrets 和 Docker 环境变量都会在运行时覆盖这些默认值。

| 变量                            | 默认值                      | 说明                                                                                                                                                                               |
| ------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_KEYS`                      | empty                       | 逗号分隔或 JSON 数组形式的 API keys。为空时关闭认证。                                                                                                                              |
| `GEMINI_COOKIE`                 | empty                       | 原始 Gemini cookie 字符串；或包含 `cookie` 和可选 `sapisid` 的 JSON；或包含 `secure_1psid`、`secure_1psidts` 和可选 `sapisid` 的 JSON。真实 Pro 路由、大上下文文本附件和已登录 Gemini Web 行为需要它。 |
| `SAPISID`                       | empty                       | 可选 SAPISID 覆盖值。为空时会尽量从 `GEMINI_COOKIE` 提取。                                                                                                                         |
| `D1_ACCOUNT_ID`                 | empty                       | 仅 Docker 使用的 Cloudflare account ID，用于 D1 HTTP binding。需与 `D1_DATABASE_ID`、`D1_API_TOKEN` 同时设置；只设置一部分会导致启动失败。                                             |
| `D1_DATABASE_ID`                | empty                       | 仅 Docker 使用的 Cloudflare D1 database ID，用于注入 `GEMINI_DB` binding。                                                                                                          |
| `D1_API_TOKEN`                  | empty                       | 仅 Docker 使用的 Cloudflare API token，需要具备查询该 D1 数据库的权限。Adapter 错误会脱敏该 token 和 SQL bind values。                                                              |
| `GEMINI_BL`                     | bundled value               | 上游请求使用的 Gemini Web build label。如果 Gemini Web 变化导致上游响应为空，需要更新它。                                                                                          |
| `GEMINI_ORIGIN`                 | `https://gemini.google.com` | 上游源站。可指向你自己的转发服务或代理地址，并保留预期请求语义。                                                                                                                   |
| `UPSTREAM_SOCKET`               | `true`                      | 可用时优先使用 `cloudflare:sockets` 作为上游传输。                                                                                                                                 |
| `DEFAULT_MODEL`                 | `gemini-3.5-flash`          | 请求省略 `model` 时使用的模型。                                                                                                                                                    |
| `RETRY_ATTEMPTS`                | `3`                         | 上游重试次数；最小值为 `1`。                                                                                                                                                       |
| `RETRY_DELAY_SEC`               | `2`                         | 重试间隔秒数；最小值为 `0`。                                                                                                                                                       |
| `REQUEST_TIMEOUT_SEC`           | `180`                       | 上游请求超时秒数；最小值为 `1`。                                                                                                                                                   |
| `LOG_REQUESTS`                  | `false`                     | 启用结构化运行阶段日志。                                                                                                                                                           |
| `CURRENT_INPUT_FILE_ENABLED`    | `true`                      | 启用用于大提示上下文的 Gemini 文本附件。                                                                                                                                           |
| `CURRENT_INPUT_FILE_MIN_BYTES`  | `95000`                     | 触发文本附件处理前的内联提示字节阈值。                                                                                                                                             |
| `CURRENT_INPUT_FILE_NAME`       | `message.txt`               | 大消息上下文附件使用的文件名。                                                                                                                                                     |
| `CURRENT_TOOLS_FILE_NAME`       | `tools.txt`                 | 大工具定义上下文附件使用的文件名。                                                                                                                                                 |
| `GENERIC_FILE_UPLOAD_MAX_BYTES` | `20971520`                  | 每个请求内附件的最大字节数。默认上传路径不会向 `content-push.googleapis.com` 发送 Gemini cookie 或 SAPISID 鉴权；请求内附件不可用或上传失败时会忽略附件并在提示词中追加说明。        |

使用 Wrangler CLI 管理 Worker 时，可通过以下命令设置可选 secrets：

- 共享部署时设置 `API_KEYS`。为空时会关闭认证。
- 需要 Pro 路由、大上下文文本附件或已登录 Gemini Web 行为时设置 `GEMINI_COOKIE`。

```sh
wrangler secret put API_KEYS
wrangler secret put GEMINI_COOKIE
```

当 `GEMINI_COOKIE` 包含 `__Secure-1PSID` 时，Worker 会为当前 isolate 保留一份内存中的活跃 cookie，并在 cookie 过期或认证上游请求失败时懒调用 Google 的 `RotateCookies` 端点。刷新后的 cookie 只保存在内存中；Worker 不会为它们使用数据库，也不会写回 Worker secrets。冷启动会重新从 `GEMINI_COOKIE` 初始化。

### D1 账号存储

当前版本已经包含未来 Gemini 账号池所需的 D1 存储基础。实时 Gemini 请求路径仍保持现有单 cookie 行为，直到后续账号 runtime/admin 任务接入。

Worker 部署时，创建 D1 数据库，执行 [`migrations/0001_gemini_accounts.sql`](migrations/0001_gemini_accounts.sql)，并在 `wrangler.jsonc` 或 Cloudflare 控制台配置中把它绑定为 `GEMINI_DB`。该 schema 会创建结构化的 `gemini_accounts`、`gemini_pool_meta` 和 `gemini_account_locks` 表，不会把账号状态作为单个 JSON blob 存储。

Docker 部署时，在 `.env` 中同时设置 `D1_ACCOUNT_ID`、`D1_DATABASE_ID` 和 `D1_API_TOKEN`。三者都存在时，`scripts/docker-server.mjs` 会注入一个基于 Cloudflare D1 HTTP API 的 D1 兼容 `GEMINI_DB` binding。只设置一部分时，启动会以配置错误失败。

对于单 cookie 部署，建议使用尽量短的 cookie 形式：`__Secure-1PSID`、`__Secure-1PSIDTS` 和可选 `SAPISID`。用新的无痕浏览器 Gemini 登录，提取这些值后关闭浏览器，通常比复制日常浏览器的完整 cookie header 更稳定。如果冷启动回退到过期的 `__Secure-1PSIDTS`，第一次认证请求会尝试刷新它。如果 Google 拒绝刷新或没有返回更新后的 cookie，需要手动更新 `GEMINI_COOKIE` secret。

短 JSON cookie 形式：

```json
{
  "secure_1psid": "YOUR_SECURE_1PSID",
  "secure_1psidts": "YOUR_SECURE_1PSIDTS",
  "sapisid": "OPTIONAL_SAPISID"
}
```

本地开发时，可以使用 Wrangler 环境支持，或通过本地 Worker 环境传入 bindings。

## 认证

当 `API_KEYS` 为空时，除 Cloudflare/Wrangler 基础设施外，所有路由都可被公开调用。任何共享部署都应至少设置一个 API key。

`web2gem` 接受以下形式：

- `Authorization: Bearer <key>`
- `x-api-key: <key>`
- `x-goog-api-key: <key>`

健康检查路由 `GET /` 保持未认证，方便部署探针在没有 secrets 的情况下工作。

## 开发

手写源码位于 `src/`。不要手动编辑 `dist/` 下的生成文件。

```sh
pnpm install
pnpm typecheck
pnpm check:arch
pnpm unit
pnpm smoke
```

构建脚本会输出两个 bundle：

| Bundle                | 来源                | 用途                              |
| --------------------- | ------------------- | --------------------------------- |
| `dist/worker.js`      | `src/index.ts`      | 由 Wrangler 部署的生产 Worker。   |
| `dist/worker.test.js` | `src/test-index.ts` | 带内部辅助导出的本地测试 bundle。 |

## 测试

| 命令                | 说明                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm typecheck`    | 使用严格编译器设置运行 TypeScript 检查。                                                   |
| `pnpm check:arch`   | 强制导入边界，并检测源码依赖环。                                                           |
| `pnpm unit:quick`   | 在需要时重建过期测试 bundle，然后用 Vitest 运行 `tests/unit/` 下的本地单元检查。           |
| `pnpm unit`         | 构建两个 bundle，并用 Vitest 运行 `tests/unit/` 下的本地单元检查。                         |
| `pnpm coverage`     | 构建隔离 coverage bundle，并将 Vitest V8 text、lcov 和 JSON summary 报告写入 `coverage/`。 |
| `pnpm coverage:ci`  | 运行带全局阈值、源码行覆盖率和分支覆盖率门禁的 Vitest V8 coverage。                        |
| `pnpm smoke`        | 构建两个 bundle，验证 public exports、请求级路由、健康检查路由和 DSML 工具调用解析。       |
| `pnpm docker:smoke` | 构建 Docker 镜像，运行临时容器，并通过 Node adapter 验证健康检查、认证和 OpenAI 路由行为。 |

Coverage 构建会把带 sourcemap 的测试 bundle 写入 `dist-coverage/`，避免普通 `dist/` 构建与 coverage 运行共享生成产物。Vitest 会发现 `tests/unit/*.test.mjs` wrapper 供 `pnpm unit` 使用；共享 case list 位于 `tests/unit/*.cases.mjs`，使用 Vitest-backed assertions；coverage 使用 Vitest 的 V8 provider 作用于隔离测试 bundle。`pnpm coverage` 和 `pnpm coverage:ci` 使用 Node runner，因此环境变量在 Windows 和 Unix shell 下处理一致。`pnpm coverage:ci` 还会通过 `scripts/check-coverage.mjs` 读取 `coverage/coverage-summary.json`，以捕获关键源码目录和选定高风险分支路径中的回归。

推荐 pre-commit gate：

```sh
pnpm typecheck
pnpm check:arch
pnpm unit
pnpm coverage:ci
pnpm smoke
# Docker 可用时可选：
pnpm docker:smoke
```

## 项目结构

```text
.
├── scripts/                 # 构建、架构、单元测试和 smoke 脚本
├── src/
│   ├── completion/          # Provider-neutral completion runtime
│   ├── config/              # 运行时配置解析
│   ├── gemini/              # Gemini Web client、transport、uploads、provider adapter
│   ├── http/                # HTTP 边界、OpenAI 和 Google 协议适配器
│   ├── models/              # 暴露的模型映射和模型解析
│   ├── promptcompat/        # API 请求形状到 Gemini prompt text 的转换
│   ├── shared/              # Provider-neutral 工具
│   ├── toolcall/            # 工具调用提示词、策略、解析器、格式化器
│   └── toolstream/          # 流式工具调用检测状态
├── tests/unit/              # 本地单元检查
├── wrangler.jsonc           # Cloudflare Worker 部署配置
└── package.json             # Node scripts 和开发依赖
```

## 安全提示

本项目适配 Gemini Web 行为，并依赖可能随时变化的上游 Web 协议细节。请将它用于个人、研究或内部验证场景；在共享部署前，请自行评估上游服务的条款和风险。

不要提交 Gemini cookies 或 API keys。请将 secrets 存放在 Cloudflare Worker secrets、Docker 环境管理或其他部署 secret 机制中。

## 致谢

[![LinuxDo](https://img.shields.io/badge/社区-LinuxDo-blue?style=for-the-badge)](https://linux.do/)

## 许可证

[MIT](LICENSE)
