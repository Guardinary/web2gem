# Release Workflows

> GitHub Actions and release asset guidelines for the root `web2gem` package.

---

## Workflow Layout

- `.github/workflows/quality-gates.yml` runs pull request plus `dev`, `main`, and
  `gemini-account-pool` push quality checks.
- `.github/workflows/release-artifacts.yml` builds GitHub Release assets and publishes the GHCR image for a release tag.
- `.github/workflows/reusable-versioned-release.yml` owns shared version calculation, synchronized package/Worker version update, release gates, commit, tag push, and release revision output.
- `.github/workflows/release-dockerhub.yml` calls the reusable versioned release workflow, then publishes Docker Hub images.
- `.github/workflows/release.yml` calls the reusable versioned release workflow, then publishes Aliyun Container Registry images.

Keep workflow names stable unless the GitHub Actions UI and README are updated together.

---

## Release Asset Contract

GitHub Releases must expose only these build artifacts plus checksum metadata:

- `worker.js`
- `web2gem_<tag>_docker_linux_amd64.tar.gz`
- `web2gem_<tag>_docker_linux_arm64.tar.gz`
- `sha256sums.txt`

Do not add bundle tarballs for `worker.js`; the raw `worker.js` asset is the Cloudflare Worker deployment artifact. Docker image archives must be split by platform and named with the `web2gem_<tag>_docker_linux_<arch>.tar.gz` pattern.

Before uploading assets, the release workflow should verify that every expected file exists and is non-empty. The upload list should stay explicit instead of relying on broad globs that can include stale artifacts.

---

## Docker Image Publishing

Docker images are named `web2gem` and are tagged with:

- the release tag, for example `v1.1.1`
- the bare package version, for example `1.1.1`
- `latest`

Docker archive assets should load into a readable local image tag, at minimum `web2gem:<tag>`. Registry images should include OCI labels for the package version and the actual release commit revision.

The final Docker runtime image must include every repository-local module imported by `scripts/docker-server.mjs`. At minimum this currently includes `d1-http-binding.mjs` and `io.mjs`; unit coverage compares the adapter's relative imports against explicit runtime-stage `COPY` entries so the container cannot pass build but exit before listening due to a missing module.

---

## Versioned Release Safety

Only one version-bumping registry release workflow should run at a time. Use a shared concurrency group for workflows that update `package.json`, create tags, or push version commits.

Before running expensive release gates, validate that the target tag does not already exist. If a workflow creates a version commit before publishing Docker images, capture `git rev-parse HEAD` after the commit and use that SHA for image revision labels.

Registry-specific release workflows should not duplicate the version bump / tag logic. Call `.github/workflows/reusable-versioned-release.yml` and consume its outputs:

- `new_version`
- `new_tag`
- `revision_sha`

Registry publish jobs should check out `revision_sha` before building Docker images so image labels and contents match the version commit.

## Scenario: Static And Independent Branch Quality Gates

### 1. Scope / Trigger

Use this contract when changing Biome severity, `check:static`, quality workflow
push branches, or release-required Docker smoke conditions.

### 2. Signatures

- `pnpm check:static` runs Biome with warning diagnostics visible and
  `--error-on-warnings` enabled.
- `.github/workflows/quality-gates.yml` owns pull-request, push, matrix unit, and
  Docker smoke gates.

### 3. Contracts

- Authored source and tests must have zero warning-or-higher Biome diagnostics.
- Framework-inapplicable rules may be disabled only through the narrowest path
  override; Preact admin UI source disables Solid-specific destructured-props
  diagnostics without weakening other correctness rules.
- Non-blocking security info diagnostics remain enabled.
- Push gates cover `dev`, `main`, and the independently released
  `gemini-account-pool` branch.
- Docker smoke runs on pushes to each of those three branches.

### 4. Validation & Error Matrix

- New Biome warning -> `pnpm check:static` exits non-zero.
- Solid-specific props info in `src/admin-ui/**` -> suppressed by the Preact-only
  override; the same override must not apply to all source.
- Push to `gemini-account-pool` -> required Ubuntu quality, Node matrix, and Docker
  smoke jobs are eligible.
- Pull request -> quality jobs run; Docker smoke remains push-only.

### 5. Good/Base/Bad Cases

- Good: fix an actionable warning before enabling `--error-on-warnings`.
- Good: add a branch to both the push trigger and Docker smoke condition.
- Base: info-level fixture security diagnostics remain reviewable but non-blocking.
- Bad: set all security rules off to make static output quiet.
- Bad: document a branch as independently released while excluding its pushes
  from required quality gates.

### 6. Tests Required

- Script test asserts `check:static` contains warning visibility and
  `--error-on-warnings`.
- Script test asserts all three push branches and the account-pool Docker smoke
  condition are present.
- Run `pnpm check:static`, `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`,
  `pnpm smoke`, and `pnpm docker:smoke` when Docker is available.

### 7. Wrong vs Correct

#### Wrong

```json
"check:static": "biome check --diagnostic-level=error"
```

#### Correct

```json
"check:static": "biome check --diagnostic-level=warn --error-on-warnings"
```

## Scenario: Package And Worker Version Synchronization

### 1. Scope / Trigger

Use this contract when preparing a major/minor/patch release or changing the version displayed by the health route or production bundle.

### 2. Signatures

- `package.json` `version` is the package/release version, for example `2.0.0`.
- `src/config/index.ts` exports `VERSION` as `<package-version>-worker`, for example `2.0.0-worker`.
- `GET /` returns the exported Worker `VERSION` in its JSON `version` field.

### 3. Contracts

- Package and Worker versions change in the same commit.
- Release workflows continue using `package.json` as the version-bump source of truth.
- `scripts/smoke.mjs` compares the built production export and health response against `package.json`; do not bypass this check with a second version file.

### 4. Validation & Error Matrix

- Package version changes without Worker `VERSION` -> smoke failure naming both values.
- Worker `VERSION` changes without package version -> the same smoke failure.
- Health response uses a stale constant -> smoke failure for stale health version.

### 5. Good/Base/Bad Cases

- Good: update `package.json` to `2.0.0` and `VERSION` to `2.0.0-worker` together.
- Base: the reusable release workflow runs `pnpm version`, rewrites the Worker suffix from the new package version, then runs smoke before tagging.
- Bad: add a standalone `VERSION` file that release workflows do not read.

### 6. Tests Required

- Run `pnpm smoke` after any version change.
- Run `pnpm check:static` when the smoke script or release workflow metadata changes.
- Confirm README branch-difference and release examples match the branch being published; do not present an independently released variant as a mainline upgrade.

### 7. Wrong vs Correct

#### Wrong

```typescript
export const VERSION = "1.1.0-worker"; // package.json is already 2.0.0
```

#### Correct

```typescript
export const VERSION = "2.0.0-worker";
```

## Scenario: Cloudflare Deploy Button Environment Classification

### 1. Scope / Trigger

- Trigger: Any change to one-click Cloudflare Worker deployment, Worker runtime environment keys, Docker env templates, or deploy-button documentation.
- Cloudflare Deploy Button treats `wrangler.jsonc` `vars` as visible Worker environment variables and dotenv entries in `.env.example` or `.dev.vars.example` as Worker secrets.

### 2. Signatures

- Worker deploy config: `wrangler.jsonc`
- Cloudflare Deploy Button secret templates: `.env.example`, `.dev.vars.example`
- Docker-only env template: `.env.docker.example`
- Binding descriptions: `package.json` `cloudflare.bindings`

### 3. Contracts

- Public Worker runtime config belongs in `wrangler.jsonc` `vars`.
- Worker secrets belong in `.env.example` and `.dev.vars.example`; keep these files limited to secret keys such as `API_KEYS` and `ADMIN_KEY`.
- Docker-only fields such as `PORT`, `WEB2GEM_IMAGE`, `D1_ACCOUNT_ID`, `D1_DATABASE_ID`, and `D1_API_TOKEN` belong in `.env.docker.example`, not `.env.example`.
- `README.md` and `README.zh.md` Docker instructions must point to `.env.docker.example`.

### 4. Validation & Error Matrix

- Non-secret Worker key appears only in `.env.example` or `.dev.vars.example` -> deploy form masks it as a secret and makes configuration opaque.
- Docker-only key appears in `.env.example` or `.dev.vars.example` -> deploy form asks for irrelevant Worker secrets.
- Secret key appears in `wrangler.jsonc` `vars` -> deploy form displays sensitive values in plain text.
- Docker docs point to `.env.example` -> users copy the Worker secret template instead of the Docker runtime template.

### 5. Good/Base/Bad Cases

- Good: `GEMINI_ORIGIN` is in `wrangler.jsonc` `vars`; `API_KEYS` is in `.env.example`; `PORT` is in `.env.docker.example`.
- Base: A new non-secret `CONFIG_ENV_KEYS` value is added to both `wrangler.jsonc` `vars` and `.env.docker.example`.
- Bad: Adding `WEB2GEM_IMAGE` or `D1_API_TOKEN` to `.env.example` or `.dev.vars.example`.

### 6. Tests Required

- `tests/unit/scripts.cases.mjs` must assert Docker config keys stay covered by `.env.docker.example` and `compose.yaml`.
- It must assert Deploy Button secrets from `.env.example` and `.dev.vars.example` stay separated from visible Worker vars in `wrangler.jsonc`.
- It must assert Docker-only keys such as `PORT`, `WEB2GEM_IMAGE`, and `D1_API_TOKEN` are absent from both Deploy Button secret templates.

### 7. Wrong vs Correct

#### Wrong

```ini
# .env.example
PORT=52389
WEB2GEM_IMAGE=ghcr.io/guardinary/web2gem:latest
API_KEYS=
```

#### Correct

```jsonc
// wrangler.jsonc
"vars": {
  "GEMINI_ORIGIN": "https://gemini.google.com"
}
```

```ini
# .env.example
API_KEYS=
ADMIN_KEY=
```

```ini
# .env.docker.example
PORT=52389
WEB2GEM_IMAGE=ghcr.io/guardinary/web2gem:latest
```

## Scenario: Generated Test Bundle Selection

### 1. Scope / Trigger

Use this contract when a quality script launches another Node process that imports a generated Worker test bundle, especially when builds use different output directories such as `dist/` and `dist-coverage/`.

### 2. Signatures

- `BENCH_TEST_BUNDLE`: repository-relative or absolute path consumed by `scripts/bench.mjs`.
- Default benchmark bundle: `dist/worker.test.js`.
- Coverage benchmark bundle: `dist-coverage/worker.test.js`.
- `TEST_BUNDLE`: Vitest test-loader path; its relative semantics belong to `tests/unit/helpers.js` and must not be reused as a script working-directory path.

### 3. Contracts

- Every generated-artifact consumer must select the artifact produced by its own build phase explicitly.
- Script bundle paths resolve from the repository working directory, not from the importing source file or a test helper directory.
- `pnpm check:bench` builds and consumes the normal `dist/worker.test.js` bundle.
- `pnpm coverage:ci` builds and consumes `dist-coverage/worker.test.js`, including benchmark subprocesses launched from tests.
- A clean checkout must not require a stale bundle left by an earlier command.

### 4. Validation & Error Matrix

- Configured bundle exists and exports benchmark helpers -> benchmark runs normally.
- Configured bundle is missing or cannot be imported -> exit nonzero with `Benchmark bundle load failed` and the resolved path.
- Coverage build exists but normal bundle is absent -> coverage and its benchmark-output test still pass.
- Normal benchmark gate starts without a test bundle -> its build step creates the normal bundle before execution.

### 5. Good/Base/Bad Cases

- Good: coverage passes `BENCH_TEST_BUNDLE=dist-coverage/worker.test.js` to Vitest subprocesses.
- Base: direct benchmark execution defaults to `dist/worker.test.js` after `build.mjs --test-bundle`.
- Bad: a subprocess hardcodes `../dist/worker.test.js` while its parent build writes only to `dist-coverage/`.

### 6. Tests Required

- Script test asserting machine-readable benchmark output works with the selected bundle.
- Script test asserting an invalid bundle path exits with a clear diagnostic.
- Clean-state `pnpm coverage:ci` run after a normal build has removed `dist/worker.test.js`.
- `pnpm check:bench` and `pnpm smoke` to preserve normal generated-bundle consumers.

### 7. Wrong vs Correct

#### Wrong

```javascript
const mod = await import("../dist/worker.test.js");
```

#### Correct

```javascript
const bundlePath = resolve(
  process.cwd(),
  process.env.BENCH_TEST_BUNDLE || "dist/worker.test.js",
);
const mod = await import(pathToFileURL(bundlePath).href);
```

## Scenario: Generated Worker Binding Types

### 1. Scope / Trigger

Use this contract when adding, removing, or renaming Wrangler vars, secrets, or Cloudflare bindings, or when changing the Worker entrypoint environment type.

### 2. Signatures

- Generated file: `worker-configuration.d.ts`.
- Generated environment interface: `WorkerBindings`.
- Generate command: `pnpm worker:types`.
- CI check command: `pnpm check:worker-types`.
- Worker entrypoint: `src/index.ts` satisfies `ExportedHandler<WorkerBindings>`.
- Application boundary: `WorkerEnv = Partial<Record<keyof WorkerBindings | "ADMIN_KEYS", unknown>>`.

### 3. Contracts

- `wrangler.jsonc` and `.dev.vars.example` are the generation inputs. The example secret file contributes secret names only; it must not contain real credentials.
- Both type commands build `dist/worker.js` before invoking Wrangler. Wrangler conditionally emits `Cloudflare.GlobalProps.mainModule` based on main-module existence, so this prerequisite makes clean-clone and post-build generation byte-for-byte deterministic.
- Generation uses `--include-runtime false` because runtime types continue to come from the pinned `@cloudflare/workers-types` dependency.
- Generation uses `--strict-vars false` so runtime-config parsers may validate deployment-provided values rather than accepting only current literal defaults.
- `WorkerBindings` types the Cloudflare entrypoint and known binding names.
- `WorkerEnv` intentionally keeps binding values as `unknown` because Docker, tests, and deployment adapters may supply string forms that `getConfig` must validate strictly.
- Removed `ADMIN_KEYS` remains an explicit compatibility-error key even though Wrangler no longer generates it.
- Do not hand-edit the generated declaration; rerun `pnpm worker:types`.

### 4. Validation & Error Matrix

- Wrangler config or secret-template key changes without regeneration -> `pnpm check:worker-types` fails.
- Type generation runs with no `dist/worker.js` prerequisite -> output hash and `Cloudflare.GlobalProps` can drift based on command order; restore the build-first script contract.
- `CONFIG_ENV_KEYS` contains a key absent from generated bindings -> unit test failure naming the key.
- `GEMINI_DB` binding disappears or changes type -> generated-type/unit/typecheck failure.
- Invalid runtime value has a generated binding name -> `getConfig` still throws `RuntimeConfigError`; generated types do not replace runtime validation.
- Removed `ADMIN_KEYS` is non-empty -> explicit runtime configuration failure, not silent omission.

### 5. Good/Base/Bad Cases

- Good: update `wrangler.jsonc` or `.dev.vars.example`, run `pnpm worker:types`, and commit the generated diff with the config change.
- Good: invoke the package scripts instead of calling `wrangler types` directly so the main-module prerequisite is stable.
- Base: the Worker entrypoint is statically checked while Docker continues passing values through the unknown-valued application boundary.
- Bad: replace runtime parsing with casts from `WorkerBindings`, or broaden the application environment back to `Record<string, unknown>`.
- Bad: generate full runtime types and remove the existing Workers types dependency as an unrelated change.

### 6. Tests Required

- `pnpm check:worker-types` in the required Ubuntu quality job.
- Unit test generated declarations contain `WorkerBindings`, `GEMINI_DB: D1Database`, and every `CONFIG_ENV_KEYS` key.
- Unit test both package scripts retain the build-first prerequisite.
- `pnpm typecheck` to verify the Worker entrypoint and application boundary remain compatible.
- `pnpm unit`, `pnpm coverage:ci`, and `pnpm smoke` after binding-type changes.

### 7. Wrong vs Correct

#### Wrong

```typescript
export type WorkerEnv = Record<string, unknown>;
export default { fetch: handleApplicationRequest };
```

#### Correct

```typescript
type WorkerEnvKey = keyof WorkerBindings | "ADMIN_KEYS";
export type WorkerEnv = Partial<Record<WorkerEnvKey, unknown>>;

export default {
  fetch: handleApplicationRequest,
} satisfies ExportedHandler<WorkerBindings>;
```

---

## Validation

For workflow changes, run:

```sh
git diff --check
pnpm typecheck
pnpm docker:smoke
```

Run broader checks such as `pnpm coverage:ci` and `pnpm smoke` when release gates, build scripts, Docker runtime behavior, or generated bundle behavior change.
