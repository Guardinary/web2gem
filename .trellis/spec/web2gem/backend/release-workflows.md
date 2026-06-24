# Release Workflows

> GitHub Actions and release asset guidelines for the root `web2gem` package.

---

## Workflow Layout

- `.github/workflows/quality-gates.yml` runs pull request, `dev`, and `main` quality checks.
- `.github/workflows/release-artifacts.yml` builds GitHub Release assets and publishes the GHCR image for a release tag.
- `.github/workflows/reusable-versioned-release.yml` owns shared version calculation, package version update, release gates, commit, tag push, and release revision output.
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

---

## Versioned Release Safety

Only one version-bumping registry release workflow should run at a time. Use a shared concurrency group for workflows that update `package.json`, create tags, or push version commits.

Before running expensive release gates, validate that the target tag does not already exist. If a workflow creates a version commit before publishing Docker images, capture `git rev-parse HEAD` after the commit and use that SHA for image revision labels.

Registry-specific release workflows should not duplicate the version bump / tag logic. Call `.github/workflows/reusable-versioned-release.yml` and consume its outputs:

- `new_version`
- `new_tag`
- `revision_sha`

Registry publish jobs should check out `revision_sha` before building Docker images so image labels and contents match the version commit.

---

## Validation

For workflow changes, run:

```sh
git diff --check
pnpm typecheck
pnpm docker:smoke
```

Run broader checks such as `pnpm coverage:ci` and `pnpm smoke` when release gates, build scripts, Docker runtime behavior, or generated bundle behavior change.
