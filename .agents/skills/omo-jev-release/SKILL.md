---
name: omo-jev-release
description: Release omo-jev-plugin through a protected-main PR, a matching tag, npm OIDC publishing, and GitHub Release. Use for version bumps, publication, or release verification in this repository.
---

# omo-jev-plugin release

Follow `CONTRIBUTING.md` and `.github/workflows/publish.yml` if they change. The v0.0.4 cycle used PR #6 and Actions run 36366004294 on 2026-09-28.

1. Confirm a clean, up-to-date `main`, an unused stable version, and no matching local or remote tag. Check `package.json`, `git ls-remote --tags origin refs/tags/vX.Y.Z`, and `npm view omo-jev-plugin@X.Y.Z version`. Do not reuse a published version or tag.
2. Create `release/vX.Y.Z` from `main`. Update `package.json.version` and the installed-version expectation in `test/update.test.ts`. Update `bun.lock` only if dependencies change. Run `bun install --frozen-lockfile`, `bun run check`, `bun test`, `bun run build`, and `npm pack --dry-run`; inspect the version and packed files. Never commit `dist/`.
3. Commit the version changes and push the release branch. Open a PR against `main`, await the required `package` check (`gh pr checks <number> --required`), and confirm the PR is mergeable. Protected `main` requires a PR; this repository permits squash merging, not merge commits. Use `gh pr merge <number> --squash` and verify the resulting merge commit. It differs from the release branch commit.
4. Fetch `origin/main` and fast-forward local `main` with `git merge --ff-only origin/main`. Verify the merged manifest version. Create an annotated `vX.Y.Z` tag **on the merged `main` commit**, confirm it with `git rev-list -n 1 vX.Y.Z`, then push the tag. Do not tag the release branch before squash merging.
5. The tag triggers `Publish to npm` in `.github/workflows/publish.yml`. Confirm `verify`, `publish`, and `release` all succeed. The workflow verifies tag/version and package contents, publishes through the `npm` GitHub environment using OIDC Trusted Publisher (`id-token: write`, not a persistent npm token), then creates a GitHub Release only after npm succeeds. Check for `+ omo-jev-plugin@X.Y.Z` and signed provenance in the publish log, plus the release attached to the tag. The `npm` environment had no required reviewers for v0.0.4; check again for each release.
6. Independently confirm public availability using `npm view omo-jev-plugin@X.Y.Z version --prefer-online --fetch-retries=0` and inspect the registry's provenance metadata. Registry propagation can briefly return 404 after a successful publish; wait for availability rather than treating the workflow alone as proof. End with a clean worktree and local `main` equal to `origin/main`.
