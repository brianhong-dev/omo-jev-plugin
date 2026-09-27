# Contributing to omo-jev-plugin

This document is for contributors and maintainers. The [README](./README.md) covers installation and configuration for users.

## Development

Install dependencies with Bun, then run the checks:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
npm pack --dry-run
```

The `pi.extensions` manifest entry points to `dist/index.js`. The `prepack` script rebuilds `dist/` before `npm pack` or `npm publish`; generated files are not committed. To load the checkout directly in senpi after building:

```sh
senpi -e ./dist/index.js
```

Keep the API boundary in mind when changing behavior: `turn_start` evaluates the current task, `context` provides advice on the next model call, and `tool_call` can block but cannot replace an already selected call. The plugin must not grant permissions on Jev's behalf. The default config remains `off`; network tests should use a local HTTP server instead of a live API key.

## Release process

The package is published to npmjs. The initial `0.0.1` version was published manually; do not push a `v0.0.1` tag because npm will not publish the same version twice. Subsequent stable releases use [`.github/workflows/publish.yml`](./.github/workflows/publish.yml), triggered by a matching `vX.Y.Z` tag. The workflow checks the tag against `package.json.version`, installs from `bun.lock`, runs type checking and tests, inspects the package, and publishes from the `npm` GitHub environment.

1. Change `package.json.version` to a new, unpublished stable version. Run `bun install` if dependencies change and commit the updated `bun.lock` in that case. Run the development checks above.
2. Commit and push the version change. Create and push the matching tag (for example, `v0.0.2`) on that commit.
3. Review the `Publish to npm` workflow's `verify` job. Approve the `npm` environment if it has required reviewers. Confirm the registry version after the `publish` job finishes.

The npm account that owns `omo-jev-plugin` must configure a [GitHub Actions Trusted Publisher](https://docs.npmjs.com/trusted-publishers/) for owner `brianhong-dev`, repository `omo-jev-plugin`, workflow filename `publish.yml`, environment `npm`, and the `npm publish` allowed action. In GitHub **Settings → Environments**, create an environment named `npm`; required reviewers and protection of `v*` tags are optional safeguards. The publish job uses GitHub OIDC (`id-token: write`), not a persistent `NPM_TOKEN` secret. npm automatically generates provenance when trusted publishing a public package from a public repository.

After a successful trusted-publisher release, maintainers can restrict traditional token publishing under the npm package's **Settings → Publishing access**. Do not do so before verifying OIDC publication. See the [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), and [GitHub environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) documentation for current settings.
