# Release Workflows

> GitHub Actions and release asset guidelines for the root `web2gem` package.

---

## Workflow Layout

- `.github/workflows/quality-gates.yml` runs pull request plus `dev`, `main`, and
  `gemini-account-pool` push quality checks.
- `.github/workflows/sync-upstream.yml` keeps deployment Forks synchronized with this branch.
- This branch contains no versioned-release or artifact-publication workflows. The default `main` branch owns `release-account-pool.yml`, `reusable-versioned-release.yml`, and `release-artifacts.yml` as the repository-wide release control plane.
- The main-branch account-pool dispatcher checks out `gemini-account-pool`, runs this branch's release gates, pushes the version commit back here, creates a `pool-v*` tag, and publishes the captured revision.

Keep workflow names stable unless the GitHub Actions UI and README are updated together.

---

## Release Asset Contract

Account-pool GitHub Releases must expose only these build artifacts plus checksum metadata:

- `web2gem-account-pool-worker.js`
- `web2gem-account-pool_<tag>_docker_linux_amd64.tar.gz`
- `web2gem-account-pool_<tag>_docker_linux_arm64.tar.gz`
- `sha256sums.txt`

Do not add bundle tarballs for the Worker asset; the raw edition-named JavaScript file is the Cloudflare Worker deployment artifact. Docker image archives must be split by platform and retain the account-pool asset prefix.

Before uploading assets, the release workflow should verify that every expected file exists and is non-empty. The upload list should stay explicit instead of relying on broad globs that can include stale artifacts.

---

## Docker Image Publishing

Account-pool Docker images use the isolated `web2gem-account-pool` repository and are tagged with:

- the release tag, for example `pool-v1.1.1`
- the bare package version, for example `1.1.1`
- `latest`

The canonical GHCR image is `ghcr.io/guardinary/web2gem-account-pool`. Docker archive assets should load into `web2gem-account-pool:<tag>`. Registry images must include OCI labels for the package version and the actual release commit revision.

The final Docker runtime image must include every repository-local module imported by `scripts/docker-server.mjs`. At minimum this currently includes `d1-http-binding.mjs` and `io.mjs`; unit coverage compares the adapter's relative imports against explicit runtime-stage `COPY` entries so the container cannot pass build but exit before listening due to a missing module.

---

## Versioned Release Safety

Only one version-bumping release workflow should run at a time across both editions. The two dispatchers on `main` share one concurrency group.

Before running expensive release gates, the control plane validates `refs/heads/main` and the complete account-pool edition tuple. Version calculation queries only `pool-v*` tags; unfiltered `git describe --tags` is forbidden because main-edition tags must not affect this branch.

The control plane validates that the target `pool-v*` tag does not exist, captures `git rev-parse HEAD` after the version commit, and uses that SHA for every asset and image build.

Registry-specific release workflows on `main` should not duplicate the version bump / tag logic. They call `.github/workflows/reusable-versioned-release.yml` and consume its outputs:

- `new_version`
- `new_tag`
- `revision_sha`

Registry publish jobs should check out `revision_sha` before building Docker images so image labels and contents match the version commit.

Account-pool version releases are branch-bound even though their dispatcher lives on `main`: explicitly checkout `gemini-account-pool` and push the version commit back to `HEAD:gemini-account-pool`. Do not restore a local copy of the release workflows on this branch.

## Scenario: Main-Controlled Account-Pool Release Publication

### 1. Scope / Trigger

Use this contract when changing account-pool publication, asset/image identity, release documentation, or the boundary between this branch and the main-branch control plane.

### 2. Signatures

- Main dispatcher: `.github/workflows/release-account-pool.yml` on `main`.
- Fixed edition tuple: `account-pool`, `gemini-account-pool`, `pool-v`, `web2gem-account-pool`, `web2gem-account-pool`.
- Branch-local workflows: `quality-gates.yml` and `sync-upstream.yml` only.

### 3. Contracts

- A maintainer runs `Release Account Pool Edition` from `main`; the dispatcher calls the shared version authority exactly once, then publishes its immutable revision.
- Publication always targets `ghcr.io/guardinary/web2gem-account-pool` and may add matching Docker Hub/Aliyun repositories to the same multi-platform build.
- Selected credentials are validated before login/build; account-pool Docker/D1 runtime contents remain part of the same Dockerfile build.
- Worker assets, Docker archives, cache scope, release title, and `latest` tag remain isolated from the main edition.
- This branch must not duplicate the main-branch release YAML files.

### 4. Validation & Error Matrix

- Prepared account-pool revision -> skip duplicate gates and publish the captured SHA.
- Main dispatcher metadata mismatch -> fail before checkout or dependency installation.
- Main-edition `v*` tag exists -> ignore it when calculating the next account-pool version.
- Missing selected registry credentials -> fail before image build.
- Optional registry disabled -> do not use its secrets or tags.

### 5. Good/Base/Bad Cases

- Good: one main-controlled version commit to this branch and one multi-registry publication build.
- Base: account-pool GHCR plus edition-named Worker/archive/checksum assets.
- Bad: restore `release.yml`, `reusable-versioned-release.yml`, or `release-artifacts.yml` on this branch.
- Bad: publish account-pool `latest` into `ghcr.io/guardinary/web2gem`.
- Bad: independent Docker Hub/Aliyun workflows each bump and tag versions.

### 6. Tests Required

- Assert every branch-local release workflow path is absent.
- Assert README, Compose, and `.env.docker.example` use the account-pool Worker asset and GHCR repository.
- Assert the canonical release gate runner remains complete because the main control plane executes it after checking out this branch.
- Run `actionlint` and the scripts unit suite.

### 7. Wrong vs Correct

#### Wrong

```yaml
jobs:
  release:
    uses: ./.github/workflows/reusable-versioned-release.yml
```

#### Correct

```yaml
# .github/workflows/release-account-pool.yml on main
name: Release Account Pool Edition
jobs:
  prepare:
    uses: ./.github/workflows/reusable-versioned-release.yml
    with:
      edition: account-pool
      source_branch: gemini-account-pool
      tag_prefix: pool-v
      asset_prefix: web2gem-account-pool
      image_repository: web2gem-account-pool
```

## Scenario: Static And Independent Branch Quality Gates

### 1. Scope / Trigger

Use this contract when changing Biome severity, scan boundaries, `check:static`,
quality workflow push branches, or release-required Docker smoke conditions.

### 2. Signatures

- `pnpm check:static` runs Biome with warning diagnostics visible and
  `--error-on-warnings` enabled.
- `biome.json` enables Git VCS integration with `useIgnoreFile: true`.
- `.github/workflows/quality-gates.yml` owns pull-request, push, matrix unit, and
  Docker smoke gates.

### 3. Contracts

- Authored source and tests must have zero warning-or-higher Biome diagnostics.
- Biome must honor `.gitignore`, `.ignore`, and Git's local exclude file so
  ignored nested repositories, virtual environments, generated output, and
  machine-local files cannot contaminate this package's static gate.
- Keep machine-specific workspace paths in Git ignore sources rather than
  hard-coding personal directory names into the shared Biome configuration.
- Framework-inapplicable rules may be disabled only through the narrowest path
  override; Preact admin UI source disables Solid-specific destructured-props
  diagnostics without weakening other correctness rules.
- Non-blocking security info diagnostics remain enabled.
- Push gates cover `dev`, `main`, and the independently released
  `gemini-account-pool` branch.
- Docker smoke runs on pushes to each of those three branches.

### 4. Validation & Error Matrix

- New Biome warning -> `pnpm check:static` exits non-zero.
- Broken symlink or unsupported file below a Git-ignored path -> Biome does not
  scan it and `pnpm check:static` remains scoped to this package.
- `vcs.enabled=false` or `useIgnoreFile=false` -> local excluded repositories may
  be traversed and can fail the gate for unrelated filesystem diagnostics.
- Solid-specific props info in `src/admin-ui/**` -> suppressed by the Preact-only
  override; the same override must not apply to all source.
- Push to `gemini-account-pool` -> required Ubuntu quality, Node matrix, and Docker
  smoke jobs are eligible.
- Pull request -> quality jobs run; Docker smoke remains push-only.

### 5. Good/Base/Bad Cases

- Good: fix an actionable warning before enabling `--error-on-warnings`.
- Good: enable Biome's Git integration and keep local repository exclusions in
  `.git/info/exclude`.
- Good: add a branch to both the push trigger and Docker smoke condition.
- Base: info-level fixture security diagnostics remain reviewable but non-blocking.
- Bad: set all security rules off to make static output quiet.
- Bad: add every developer's sibling repository or virtual environment to
  `files.includes` exceptions.
- Bad: document a branch as independently released while excluding its pushes
  from required quality gates.

### 6. Tests Required

- Script test asserts `check:static` contains warning visibility and
  `--error-on-warnings`.
- Run `pnpm check:static` with an ignored nested directory present and verify
  Biome reports no files or filesystem diagnostics from that directory.
- `pnpm exec biome rage` reports `VCS enabled: true`.
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

```json
{
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  }
}
```

## Scenario: Dependency Upgrade And Supply-Chain Policy

### 1. Scope / Trigger

Use this contract when upgrading direct dependencies, changing
`pnpm-workspace.yaml` supply-chain policy, or regenerating `pnpm-lock.yaml`.

### 2. Signatures

- Upgrade command: `pnpm update --latest`.
- Explicit policy-approved version command: `pnpm add --save-dev <package>@<version>`.
- Freshness check: `pnpm outdated`.
- Lockfile reproducibility check: `pnpm install --frozen-lockfile`.
- Supply-chain exceptions: exact package versions in
  `pnpm-workspace.yaml` `minimumReleaseAgeExclude`.

### 3. Contracts

- `package.json` and `pnpm-lock.yaml` change together for every direct dependency
  upgrade; do not hand-edit resolved lockfile entries.
- `minimumReleaseAgeExclude` entries are exact, intentional exceptions for
  versions that the project accepts before the normal release-age policy allows
  them. Replace the previous exact exception when upgrading the same package;
  do not accumulate stale versions.
- Do not add a pnpm override merely to bypass release-age policy. Use an override
  only for a documented resolver or compatibility requirement.
- A Wrangler or `@cloudflare/workers-types` upgrade must preserve generated
  Worker bindings and runtime compatibility.

### 4. Validation & Error Matrix

- Manifest changed with stale lockfile -> `pnpm install --frozen-lockfile` fails.
- Upgrade output reports a newer version but selects an older policy-approved
  version -> inspect the exact `minimumReleaseAgeExclude` entry, update it only
  when intentionally accepting the newer release, and install that version
  explicitly.
- `pnpm outdated` has output after the intended upgrade -> review every remaining
  direct dependency before completion.
- Workers types or Wrangler incompatibility -> `pnpm check:worker-types` or
  `pnpm typecheck` fails.
- Vulnerable resolved dependency -> `pnpm audit --audit-level moderate` fails.

### 5. Good/Base/Bad Cases

- Good: run `pnpm update --latest`, review the manifest and lockfile diff, then
  run the frozen-lockfile and project quality gates.
- Good: replace an old exact Workers types release-age exception with the newly
  reviewed exact version.
- Base: packages already at latest remain unchanged.
- Bad: claim all dependencies are current based only on a successful install
  when the updater reported a newer policy-blocked version.
- Bad: disable supply-chain policy globally to install one fresh package.

### 6. Tests Required

- Run `pnpm install --frozen-lockfile`, `pnpm outdated`, and
  `pnpm audit --audit-level moderate`.
- Run `pnpm check:static`, `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`,
  `pnpm coverage:ci`, and `pnpm smoke` after dependency upgrades.
- Run `pnpm check:worker-types` when Wrangler or Workers types change.
- Run `pnpm check:bench` and `pnpm check:size` when build/runtime dependencies
  change.

### 7. Wrong vs Correct

#### Wrong

```yaml
minimumReleaseAgeExclude:
  - '@cloudflare/workers-types@<old-version>'
  - '@cloudflare/workers-types@<new-version>'
```

#### Correct

```yaml
minimumReleaseAgeExclude:
  - '@cloudflare/workers-types@<reviewed-version>'
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
- Account-pool Deploy Button repository: `https://github.com/Guardinary/web2gem/tree/gemini-account-pool`

### 3. Contracts

- Public Worker runtime config belongs in `wrangler.jsonc` `vars`.
- Worker secrets belong in `.env.example` and `.dev.vars.example`; keep these files limited to secret keys such as `API_KEYS` and `ADMIN_KEY`.
- Docker-only fields such as `PORT`, `WEB2GEM_IMAGE`, `D1_ACCOUNT_ID`, `D1_DATABASE_ID`, and `D1_API_TOKEN` belong in `.env.docker.example`, not `.env.example`.
- `README.md` and `README.zh.md` Docker instructions must point to `.env.docker.example`.
- Every Deploy to Cloudflare link in `README.md` and `README.zh.md` must pin the `gemini-account-pool` branch so Cloudflare reads the account-pool secret templates rather than the legacy default branch.

### 4. Validation & Error Matrix

- Non-secret Worker key appears only in `.env.example` or `.dev.vars.example` -> deploy form masks it as a secret and makes configuration opaque.
- Docker-only key appears in `.env.example` or `.dev.vars.example` -> deploy form asks for irrelevant Worker secrets.
- Secret key appears in `wrangler.jsonc` `vars` -> deploy form displays sensitive values in plain text.
- Docker docs point to `.env.example` -> users copy the Worker secret template instead of the Docker runtime template.
- Deploy Button omits `/tree/gemini-account-pool` -> Cloudflare clones the repository default branch and may request legacy `GEMINI_COOKIE` or `SAPISID` secrets.

### 5. Good/Base/Bad Cases

- Good: `GEMINI_ORIGIN` is in `wrangler.jsonc` `vars`; `API_KEYS` is in `.env.example`; `PORT` is in `.env.docker.example`.
- Base: A new non-secret `CONFIG_ENV_KEYS` value is added to both `wrangler.jsonc` `vars` and `.env.docker.example`.
- Bad: Adding `WEB2GEM_IMAGE` or `D1_API_TOKEN` to `.env.example` or `.dev.vars.example`.
- Bad: Using the bare repository URL in an account-pool Deploy Button while the repository default branch still contains the legacy cookie deployment.

### 6. Tests Required

- `tests/unit/scripts.cases.mjs` must assert Docker config keys stay covered by `.env.docker.example` and `compose.yaml`.
- It must assert Deploy Button secrets from `.env.example` and `.dev.vars.example` stay separated from visible Worker vars in `wrangler.jsonc`.
- It must assert Docker-only keys such as `PORT`, `WEB2GEM_IMAGE`, and `D1_API_TOKEN` are absent from both Deploy Button secret templates.
- It must assert all English and Chinese README Deploy Buttons pin the canonical `gemini-account-pool` repository URL.

### 7. Wrong vs Correct

#### Wrong

```ini
# .env.example
PORT=52389
WEB2GEM_IMAGE=ghcr.io/guardinary/web2gem-account-pool:latest
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
WEB2GEM_IMAGE=ghcr.io/guardinary/web2gem-account-pool:latest
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
- Application boundary: `WorkerEnv = Partial<Record<keyof WorkerBindings, unknown>>`.

### 3. Contracts

- `wrangler.jsonc` and `.dev.vars.example` are the generation inputs. The example secret file contributes secret names only; it must not contain real credentials.
- Both type commands build `dist/worker.js` before invoking Wrangler. Wrangler conditionally emits `Cloudflare.GlobalProps.mainModule` based on main-module existence, so this prerequisite makes clean-clone and post-build generation byte-for-byte deterministic.
- Generation uses `--include-runtime false` because runtime types continue to come from the pinned `@cloudflare/workers-types` dependency.
- Generation uses `--strict-vars false` so runtime-config parsers may validate deployment-provided values rather than accepting only current literal defaults.
- `WorkerBindings` types the Cloudflare entrypoint and known binding names.
- `WorkerEnv` intentionally keeps binding values as `unknown` because Docker, tests, and deployment adapters may supply string forms that `getConfig` must validate strictly.
- Unknown or removed environment keys are not added to `WorkerEnv` for compatibility handling.
- Do not hand-edit the generated declaration; rerun `pnpm worker:types`.

### 4. Validation & Error Matrix

- Wrangler config or secret-template key changes without regeneration -> `pnpm check:worker-types` fails.
- Type generation runs with no `dist/worker.js` prerequisite -> output hash and `Cloudflare.GlobalProps` can drift based on command order; restore the build-first script contract.
- `CONFIG_ENV_KEYS` contains a key absent from generated bindings -> unit test failure naming the key.
- `GEMINI_DB` binding disappears or changes type -> generated-type/unit/typecheck failure.
- Invalid runtime value has a generated binding name -> `getConfig` still throws `RuntimeConfigError`; generated types do not replace runtime validation.
- Unknown environment key is present -> it remains outside `CONFIG_ENV_KEYS` and does not alter parsed runtime configuration.

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
export type WorkerEnv = Partial<Record<keyof WorkerBindings, unknown>>;

export default {
  fetch: handleApplicationRequest,
} satisfies ExportedHandler<WorkerBindings>;
```

---

## Scenario: Isolated Docker Build Context

### 1. Scope / Trigger

Use this contract when changing `Dockerfile`, `.dockerignore`, Docker smoke behavior, or files copied into build stages.

### 2. Signatures

- Build inputs: package manifests, TypeScript/Vitest/Wrangler config, `scripts/`, and `src/`.
- Safe templates: `.env.example`, `.env.docker.example`, and `.dev.vars.example`.

### 3. Contracts

- Exclude `.env`, `.env.*`, `.dev.vars`, and `.dev.vars.*`, then re-include only committed examples.
- Exclude tests, docs, reports, coverage, and release assets when not copied by `Dockerfile`.
- Preserve every repository path copied by `Dockerfile`, including account-pool runtime adapters under `scripts/`.

### 4. Validation & Error Matrix

- Real environment file -> excluded.
- Safe example matching a wildcard -> later negation re-includes it.
- New Docker `COPY` source -> update the context contract test.

### 5. Good/Base/Bad Cases

- Good: keep wildcard exclusions before example negations.
- Base: `scripts/` and `src/` remain available.
- Bad: send local secrets, tests, or coverage to the Docker daemon.

### 6. Tests Required

- Assert sensitive and repository-only patterns are excluded.
- Assert safe example negations and every Docker build input.
- Run the scripts unit suite and Docker smoke when container startup is authorized.

### 7. Wrong vs Correct

#### Wrong

```dockerignore
.env.*
scripts
```

#### Correct

```dockerignore
.env.*
!.env.example
!.env.docker.example
.dev.vars.*
!.dev.vars.example
tests
docs
```

## Scenario: Risk-Routed Pull Request Gates

### 1. Scope / Trigger

Use this contract when changing the quality workflow or changed-file classifier.

### 2. Signatures

- `classifyChangedFiles(files)` returns `docs` or `runtime`.
- `Required Gates - Ubuntu` remains the stable aggregate required-check name.

### 3. Contracts

- Every PR runs the classifier. Only root README files, `LICENSE`, and `docs/` paths are documentation-only.
- Empty, unknown, workflow, Trellis spec, migration, admin UI, source, test, script, config, and Docker sets fail closed to runtime.
- Pushes to `dev`, `main`, and `gemini-account-pool`, plus manual runs, always execute full gates.
- Documentation-only PRs retain the Ubuntu required job while skipping dependency installation, coverage, benchmarks, bundle checks, and the Node matrix.

### 4. Validation & Error Matrix

- README plus docs image -> docs.
- Account migration or admin UI source -> runtime.
- Non-PR event -> runtime without diff classification.

### 5. Good/Base/Bad Cases

- Good: repository-owned Node classifier fed by NUL-separated Git paths.
- Base: preserve account-pool push and Docker smoke conditions.
- Bad: skip the entire workflow with `paths-ignore`.

### 6. Tests Required

- Unit-test representative documentation and account-pool runtime paths.
- Contract-test stable job names and conditional heavy jobs.
- Run `actionlint` across all workflows.

### 7. Wrong vs Correct

#### Wrong

```yaml
pull_request:
  paths-ignore: ["**/*.md"]
```

#### Correct

```yaml
ubuntu-quality:
  name: Required Gates - Ubuntu
  needs: classify
```

## Scenario: Fork-Synchronized Cloudflare Deployments

### 1. Scope / Trigger

Use this contract when changing the Cloudflare Deploy Button, Worker entrypoint,
D1 draft binding, deployment-repository synchronization, or documentation for
upgrading an existing one-click deployment.

### 2. Signatures

- Draft D1 binding: `wrangler.jsonc` `d1_databases[].binding = "GEMINI_DB"`.
- Deploy Button entrypoint: `wrangler.jsonc` `main = "src/index.ts"`.
- Release and Docker bundle: `scripts/build.mjs` writes `dist/worker.js`.
- Migration command: `wrangler d1 migrations apply GEMINI_DB --remote`.
- Sync workflow: `.github/workflows/sync-upstream.yml`.
- Upstream source: `https://github.com/Guardinary/web2gem.git`, branch
  `gemini-account-pool`.
- User triggers: weekly `schedule` plus `workflow_dispatch` on a true GitHub
  Fork whose default branch is `gemini-account-pool`.

### 3. Contracts

- Keep `wrangler.jsonc` portable: declare the stable D1 binding/resource name
  but omit `database_id`. Cloudflare/Wrangler automatic provisioning owns the
  physical resource association outside Git.
- Keep `wrangler.jsonc` `main` pointed at committed source that exists in a
  fresh clone. Deploy Button resolves the entrypoint before running the package
  build command, so generated `dist/worker.js` cannot be the deployment
  entrypoint even though it remains the release and Docker bundle.
- Do not put D1 database IDs in Deploy Button secret templates or GitHub
  Secrets. `ADMIN_KEY` and optional `API_KEYS` remain Worker secrets.
- The sync job requests only `contents: write`, requires
  `github.event.repository.fork`, and serializes runs with concurrency.
- Use `aormsby/Fork-Sync-With-Upstream-action@v3.4` with the canonical repository
  and `gemini-account-pool` as both upstream and target branches.
- Pass the repository `GITHUB_TOKEN` as `target_repo_token`; do not require a
  personal token or Cloudflare API token.
- Use fast-forward-only upstream pulls. Treat `gemini-account-pool` in the Fork
  as a non-working deployment branch; divergence fails instead of overwriting
  user commits.
- Cloudflare Deploy Button clones are first-deployment-only and are not the
  automatic-update path. Recommend a standard GitHub Fork imported into
  Cloudflare Workers Builds.
- Users must copy all branches when forking and set `gemini-account-pool` as the
  Fork default branch because scheduled workflows run only from the default
  branch.
- Source quality-gate entry jobs must require
  `github.repository == 'Guardinary/web2gem'` so copied workflows do not consume
  deployment-repository Actions minutes.
- A `GITHUB_TOKEN` push does not trigger another workflow in the same GitHub
  repository; deployment must rely on the external Cloudflare Git integration,
  not a second push-triggered GitHub Actions workflow.

### 4. Validation & Error Matrix

- No upstream update -> workflow succeeds without push.
- Clean upstream update -> fast-forward the Fork target branch and push.
- Fork already current -> succeed without a new push.
- Target branch diverged -> fast-forward pull fails without force push.
- Repository is a Deploy Button clone rather than a Fork -> sync job is skipped;
  use the documented manual upstream commands or redeploy through Fork + Import.
- Actions disabled or token write denied -> push fails; user enables Actions
  and read/write workflow permissions.
- Protected deployment branch rejects bot push -> fail without bypass; user
  adjusts branch policy or synchronizes manually.
- Sync succeeds but Cloudflare build fails -> inspect Cloudflare Builds; do not
  rerun the Deploy Button and create a duplicate Worker.
- Draft D1 binding cannot be parsed -> `wrangler deploy --dry-run` or Worker
  binding type checks fail before release.
- `main` points at ignored `dist/worker.js` -> a fresh Deploy Button clone fails
  during project setup with a Wrangler configuration parsing error before the
  build command can generate the file.

### 5. Good/Base/Bad Cases

- Good: a true Fork fast-forwards weekly and its Cloudflare Git integration
  deploys the same Worker.
- Good: `main` points at tracked `src/index.ts`; the build may still generate
  `dist/worker.js` for release assets and Docker.
- Base: the Fork is already current and the scheduled run exits idempotently.
- Bad: rerun the Deploy Button to upgrade and create a duplicate Worker.
- Bad: commit a user-specific D1 UUID or generate `wrangler.jsonc` from a GitHub
  secret.
- Bad: point `main` at an ignored build artifact and assume Deploy Button runs
  `pnpm build` before resolving the Wrangler configuration.
- Bad: `git reset --hard upstream/gemini-account-pool` followed by force push.
- Bad: promise that every Deploy Button repository contains GitHub Actions
  workflows without verifying the generated repository.

### 6. Tests Required

- Assert `GEMINI_DB` keeps its stable `database_name` and has no `database_id`
  property.
- Assert `wrangler.jsonc` `main` is `src/index.ts` and the file exists in the
  repository.
- Assert the migration script continues referencing the binding name.
- Assert weekly and manual triggers, `contents: write`, the true-Fork guard,
  action version, upstream/target repository and branch inputs, `GITHUB_TOKEN`,
  and fast-forward-only pulls.
- Assert the workflow contains no force push, hard reset, Cloudflare API token,
  or D1 ID handling.
- Assert source quality-gate jobs skip copied deployment repositories.
- Assert both READMEs label the Deploy Button as first-deployment-only, recommend
  standard Fork plus Cloudflare Import, cover all-branch Fork creation and
  default-branch selection, and document manual recovery for existing clones.
- Run `pnpm exec actionlint`, `pnpm check:worker-types`, `pnpm unit`,
  `pnpm coverage:ci`, `pnpm smoke`, and `wrangler deploy --dry-run`.

### 7. Wrong vs Correct

#### Wrong

```jsonc
{
  "main": "dist/worker.js",
  "d1_databases": [{
    "binding": "GEMINI_DB",
    "database_name": "web2gem-gemini-accounts",
    "database_id": "<user-specific-id>"
  }]
}
```

```sh
git reset --hard upstream/gemini-account-pool
git push --force origin HEAD
```

#### Correct

```jsonc
{
  "main": "src/index.ts",
  "d1_databases": [{
    "binding": "GEMINI_DB",
    "database_name": "web2gem-gemini-accounts"
  }]
}
```

```yaml
if: ${{ github.event.repository.fork }}
uses: aormsby/Fork-Sync-With-Upstream-action@v3.4
with:
  upstream_sync_repo: Guardinary/web2gem
  upstream_sync_branch: gemini-account-pool
  target_sync_branch: gemini-account-pool
  target_repo_token: ${{ secrets.GITHUB_TOKEN }}
  upstream_pull_args: "--ff-only"
```

## Validation

For workflow changes, run:

```sh
git diff --check
pnpm typecheck
pnpm docker:smoke
```

Run broader checks such as `pnpm coverage:ci` and `pnpm smoke` when release gates, build scripts, Docker runtime behavior, or generated bundle behavior change.
