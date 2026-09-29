# SOURCE KNOWLEDGE BASE

## OVERVIEW
Runtime integration and its configuration, Jev decision, and update boundaries. This distinct module domain scores 9 on the init-deep matrix (code ratio, module entry, symbol density, exports, own configuration).

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Lifecycle behavior | `index.ts` | Default plugin export; `session_start`, `before_agent_start`, `turn_start`, `context`, `tool_call`, shutdown |
| Config validation | `config.ts` | Strict JSONC schema, global creation, trusted-project overrides, API key lookup |
| Jev response handling | `decision.ts` | Question construction, candidate validation, risk score, SDK transport |
| Update notice | `update.ts` | Installed package version and npm registry comparison |

## CONVENTIONS
- `session_start` clears stale per-session state, then constructs `JevDecider` only with an enabled, non-`off` config and available API key.
- `before_agent_start` resets per-run state; explicit skill syntax suppresses automatic skill suggestions.
- `turn_start` deduplicates an unchanged state fingerprint and shares the configured call budget with `tool_call` preflight.
- `shadow` records decisions only; `advise` injects hidden context; `act` alone may activate tools or change the session model/thinking level.
- `context` appends advice to the supplied messages; `tool_call` can block an already selected call but cannot replace it.
- `config.ts` creates only the global file when absent, with mode `advise` and private permissions; existing files without a mode still default to `off`, and project config is read only when the project is trusted.
- `decision.ts` validates selected candidates and thresholds locally; the SDK client disables retries and logging.
- `tool_result` retains the last four summaries; actual output text is included only when configured.
- `config.ts` resolves the API key from the file first, then `TYPESAFE_API_KEY`.
- `update.ts` compares three numeric version components and treats unavailable registry responses as no update.

## ANTI-PATTERNS
- Do not offer an inactive tool unless `act` mode permits its explicit activation.
- Do not replace candidate validation with confidence alone; a choice must be present in the supplied candidates and pass fit thresholds.
- Do not inject advice during `shadow` or `off` mode.
- Do not assume preflight errors always block: `preflightOnError` controls that choice, defaulting to `allow`.
