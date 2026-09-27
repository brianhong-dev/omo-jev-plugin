# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-27
**Commit:** 83d660d
**Branch:** main

## OVERVIEW
TypeScript extension for OmO/senpi that asks Jev for skill and tool recommendations, progress judgments, and optional preflight risk scores. Bun drives development and tests; the published ESM package supports Node.js 20+.

## STRUCTURE
```text
./
├── index.js                 # Host-loaded extension shim; exports built plugin
├── src/                     # Runtime hooks, config, Jev client, update check
├── test/                    # Bun tests by config/decision/update boundary
├── jev-plugin.example.jsonc # Documented opt-in configuration
└── .github/workflows/       # CI and tag-triggered npm release
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Extension lifecycle and modes | `src/index.ts` | Default export registers host hooks; see `src/AGENTS.md` |
| First-run and project config | `src/config.ts`, `test/config.test.ts` | Strict JSONC; project override requires trust |
| Jev protocol and candidate selection | `src/decision.ts`, `test/decision.test.ts` | SDK request and validated responses |
| Update announcement | `src/update.ts`, `test/update.test.ts` | Registry check at session startup |
| Published entry and package contents | `index.js`, `package.json`, `tsconfig.build.json` | `dist/` is built for packing, not committed |
| Release process | `CONTRIBUTING.md`, `.github/workflows/publish.yml` | Tag version must match package version |

## CODE MAP
| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `jevPlugin` | default function | `src/index.ts:79` | entry shim | Registers the host hooks |
| `loadConfig` | function | `src/config.ts:121` | 16 | Creates/merges validated configuration |
| `JevDecider` | class | `src/decision.ts:67` | 9 | Jev requests and parsed decisions |
| `newerVersion` | function | `src/update.ts:12` | 7 | Compares installed and registry versions |
| `startupNotice` | function | `src/index.ts:33` | config tests | Startup warning and status formatter |

## CONVENTIONS
- Development uses Bun (`bun.lock`, `bun test`), while package metadata declares Node.js 20+.
- TypeScript uses NodeNext ESM imports with `.js` suffixes and strict compiler options.
- Global config is `~/.omo/jev-plugin.jsonc`; optional project config is `.omo/jev-plugin.jsonc` in trusted projects only.
- Default mode is `off`; enabling Jev and choosing `shadow`, `advise`, or `act` is explicit.
- API keys resolve from config or `TYPESAFE_API_KEY`; tool output is excluded from Jev state unless opted in.
- `prepack` builds `dist/`; root `index.js` keeps the extension identity outside the generated directory.
- Network tests use a local HTTP server for SDK traffic and inject a request function for the registry check.

## ANTI-PATTERNS (THIS PROJECT)
- Jev suggestions never grant permissions; the host remains the authority for tool execution.
- Do not turn on network decisions or create project-local config automatically on first load.
- Do not commit `dist/` or depend on a live API key in tests.
- Do not push the already-published `v0.0.1` tag.
- Do not restrict npm token publishing until OIDC trusted publishing has been verified.

## UNIQUE STYLES
- User-facing installation/configuration documentation is Korean (`README.md`); contributor and release instructions are English (`CONTRIBUTING.md`).
- `shadow` observes, `advise` adds context suggestions, and `act` can apply only configured controls.
- npm publication uses tag-triggered GitHub OIDC and creates a GitHub Release only after publish succeeds.

## COMMANDS
```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
npm pack --dry-run
senpi -e ./index.js # after building, load checkout in the host
```

## NOTES
- The host extension path is `index.js`; package imports resolve `dist/index.js` through `exports`.
- `session_start` checks npm for an update before loading config; unavailable registry access does not stop plugin startup.
- `test/config.test.ts` covers pure notice helpers but does not exercise the complete host event lifecycle.
