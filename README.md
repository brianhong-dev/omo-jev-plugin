# omo-jev-plugin

Jev decision assistance for [senpi](https://www.npmjs.com/package/@code-yeongyu/senpi) and OmO. This is a senpi extension distributed as an npm package. Jev returns typed judgments; senpi remains responsible for calling tools and enforcing permissions.

## Install

Use senpi's package installer:

```sh
senpi install npm:omo-jev-plugin
```

For a local checkout, run `bun install && bun run build`, then:

```sh
senpi -e ./dist/index.js
```

Set `TYPESAFE_API_KEY` in the environment of the senpi process. The plugin uses the official `@typesafe-ai/sdk` and its `TYPESAFE_BASE_URL` override when present. Without a key, the plugin reports a warning and falls back to ordinary senpi behavior when enabled.

## Configure

Copy [`jev-plugin.example.jsonc`](./jev-plugin.example.jsonc) to `~/.omo/jev-plugin.jsonc`. This is the plugin's own file; it does not edit `~/.omo/omo.jsonc`. A trusted project can override individual fields in `.omo/jev-plugin.jsonc`. Nested `decisions`, `limits`, and `thresholds` are merged; other fields replace the global value. An untrusted project's file is ignored.

The default mode with no configuration is `off`, so installation alone makes no external requests.

| Mode | Behavior |
| --- | --- |
| `off` | No Jev calls. |
| `shadow` | Judge and record minimal decision metadata in the session; change nothing. |
| `advise` | Add short, ephemeral recommendations to each model request. |
| `act` | Advise and apply only explicitly enabled runtime actions. |

`skills` and `nextAction` examine available skill and active tool descriptions on **each agent turn**, not just when a session starts. `toolDiscovery` can suggest `tool_search` when it is active. `resultAssessment` and `loopDetection` evaluate recent tool outcomes; `completion` adds a tentative completion suggestion, not a forced stop. Calls for identical state are suppressed and `maxCallsPerAgentRun` limits requests.

The following settings only change runtime state in `act` mode:

- `toolActivation`: promote only tool names explicitly listed in `activatableTools`; leave it off to preserve senpi's ordinary deferred `tool_search` flow.
- `toolPreflight`: ask Jev whether a proposed call appears outside the user's requested scope. Block when its Noul value meets `thresholds.risk`. `preflightOnError` controls whether an unavailable gate allows or blocks the call. Neither value bypasses senpi's own permission checks.
- `modelRouting`: choose only from `models` (entries such as `"provider/model-id"`) that are available to this session. Uses session-scoped model selection.
- `thinkingLevel`: choose among senpi's supported thinking levels for this session.

Unknown or low-confidence candidates are not recommended. `thresholds.fit` is the minimum absolute applicability Noul, while `thresholds.confidence` applies to Choice. These numbers are starting points, not calibrated guarantees. The API model is pinned by default to `jev-1.13.0`; retune thresholds before changing it.

Only the bounded current request, tool/skill metadata, and recent tool names with success/error status are sent to Jev by default. Set `includeToolOutput: true` **only if sending snippets of tool output to TypeSafe is acceptable for your environment**; proposed `toolPreflight` requests include the selected call's arguments when enabled. Neither the full transcript nor API key is written to decision entries. Network errors, invalid responses, and a missing API key leave ordinary senpi behavior intact for recommendations.

## Develop

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
npm pack --dry-run
```

The `pi.extensions` entry points to `dist/index.js`; `prepack` builds it before publishing. [GitHub Actions](./.github/workflows/publish.yml) verifies the tag, types, tests, and archive before publishing with [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/). It uses GitHub OIDC instead of a persistent `NPM_TOKEN`. The `publish` job has `id-token: write` and uses the `npm` GitHub environment; npm automatically attaches provenance for a public package from a public repository.

## Set up automatic npm releases

1. Create a **public GitHub repository**, push this project, and enable GitHub Actions. No GitHub remote is currently embedded in the package. The workflow fills in the exact `repository.url` from `GITHUB_REPOSITORY` on the publish runner, as required by npm provenance. Ensure the repo name/owner you use on npm exactly matches this GitHub repository.
2. On GitHub, create an environment named **`npm`** under **Settings → Environments**. Add required reviewers if you want approval before every publish. Protect release tags (`v*`) with a repository ruleset so only maintainers can create them. No GitHub `NPM_TOKEN` secret is needed.
3. A **new npm package must first exist** before its Trusted Publisher settings can be opened. On a machine logged in to an npm account allowed to own the package, confirm `npm whoami`, check that `omo-jev-plugin` is available, run the development checks above, and publish **`0.1.0` once** with `npm publish --access public`. npm may ask for 2FA. Do not push a `v0.1.0` tag afterwards: the registry already has that version.
4. Open **npmjs.com → Packages → omo-jev-plugin → Settings → Trusted publishing → Add trusted publisher → GitHub Actions**. Set **Organization or user** to your GitHub owner, **Repository** to its exact name, **Workflow filename** to `publish.yml` (not its full path), **Environment name** to `npm`, and enable the **`npm publish`** allowed action. All names are case-sensitive.
5. For later versions, increment `package.json` and `bun.lock` together, commit them, and push a matching stable tag `vX.Y.Z`. The `publish.yml` workflow refuses a tag that differs from `package.json.version` or includes a prerelease suffix. Its `verify` job must pass before the OIDC-enabled `publish` job runs. With the GitHub environment configured, the publish job pauses for any required review. A package version cannot be published twice.
6. Once a Trusted Publisher release succeeds, consider npm package **Settings → Publishing access → Require two-factor authentication and disallow tokens**. This does not disable OIDC trusted publishing. Remove any old publish tokens only after the OIDC path has worked.

The first manual publish is a one-time bootstrap. If a package with this name already belongs to someone else by then, change `package.json.name` before the first publish and use that exact name in npm settings. The GitHub owner and repository cannot be filled in here until the destination repository is chosen.

See [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/) for the current field names, [npm provenance](https://docs.npmjs.com/generating-provenance-statements/) for public repository requirements, and [GitHub environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) for reviewer protection.
