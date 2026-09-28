# omo-jev-plugin

English | [한국어](./README.ko.md)

This plugin connects structured decisions from [Jev](https://docs.typesafe.ai/) or OpenRouter's [Span-01](https://openrouter.ai/respan/span-01) and [Span-01 Lite](https://openrouter.ai/respan/span-01-lite) to [OmO](https://www.npmjs.com/package/omo-ai) / senpi agents. It evaluates which skills and next tools fit a task, looks for repetition or possible completion, and gives the agent brief suggestions. The decision model neither executes tools nor replaces senpi's permission checks.

## Installation

Install the package in OmO or senpi:

```sh
omo install npm:omo-jev-plugin
```

When the plugin loads, it checks npm for a newer version and announces an available update in the UI before checking configuration or API keys. Run `omo update npm:omo-jev-plugin` to update. A failed npm lookup does not prevent startup.

Set the provider-specific API key in `~/.omo/jev-plugin.jsonc` under `provider.jev_compatible.apiKey` or `provider.respan-ai.apiKey`. If absent, the plugin uses `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`, respectively, from the **process running OmO/senpi**. Each provider also supports an `endpoint`. Be careful when sharing project configuration containing a key. If the selected provider has no key, the plugin warns on load and makes no decision requests.

Installation alone does not call the decision API. On first load, the plugin creates a default configuration file in `off` mode. Change its mode as described below to enable it.

### Telemetry

For plugin maintenance and usage statistics, we collect a pseudonymous installation ID and plugin usage counts.

Detailed telemetry is enabled by default and also collects the decision mode, provider, decision-call count, input and output token totals, and estimated cost. To turn off detailed telemetry, add `"telemetry": { "detailed": false }` to your global `~/.omo/jev-plugin.jsonc` and start a new session. This setting does not disable installation ID and usage-count collection, and it is not added to automatically generated configuration files.

## Configuration

On first load, `~/.omo/jev-plugin.jsonc` is created with `mode: "off"`. Legacy top-level `model`, `apiKey`, `openrouterApiKey`, and `endpoint` settings are moved under `provider` when loaded. Before changing the file, the plugin backs it up as `jev-plugin.jsonc.bak.<timestamp>` and records the migration in `_migrations`, preserving existing settings and comments where possible. A project configuration contains only the fields it needs to override; it is not filled in automatically. See the [example configuration](./jev-plugin.example.jsonc). This file is separate from OmO's `omo.jsonc`. Start a new session or reload the extension after changing settings.

The simplest configuration is:

```jsonc
{
  "mode": "advise",
  "provider": {
    "selected": "jev_compatible",
    "jev_compatible": { "apiKey": "your-typesafe-key" }
  },
  "display": {
    "startup": true,
    "decisions": true
  },
  "decisions": {
    "skills": true,
    "nextAction": true,
    "loopDetection": true,
    "completion": true
  }
}
```

### Decision provider

`provider.selected` is `jev_compatible` (the default) or `respan-ai`. Each provider has its own `model`, `apiKey`, and `endpoint`. When the model ID is omitted, the defaults are `jev-1.13.0` and `respan/span-01-lite`, respectively. To use Respan:

```jsonc
{
  "mode": "advise",
  "provider": {
    "selected": "respan-ai",
    "respan-ai": { "apiKey": "your-openrouter-key" }
  }
}
```

If `provider.respan-ai.apiKey` is absent, the plugin uses `OPENROUTER_API_KEY`. You can keep options for both providers in the global configuration and override only `provider.selected` in a trusted project.

`jev_compatible` uses `noul`, `choice`, and `score` directly. `respan-ai` defaults to the free **Span-01 Lite** on OpenRouter and directly uses only the `noul` primitive currently accepted by its API. The plugin evaluates each option or score level with `noul` and combines the results, so its selections and scores can differ from Jev's direct responses. Setting `respan-ai.model` changes the default model ID but not the provider-specific decision method. The `provider` section configures the plugin's decision model; top-level `models` lists candidates for routing the agent session model.

You can place a project override in `.omo/jev-plugin.jsonc`. The plugin does not create it and reads it only when the project is trusted. Provider-specific entries, `decisions`, `display`, `limits`, and `thresholds` are merged field by field; other project values replace global values. An unknown setting or invalid JSONC disables the plugin and displays a warning.

| Mode | Behavior |
| --- | --- |
| `off` | Do not call Jev. This is the default. |
| `shadow` | Record decisions in the session without changing agent behavior. |
| `advise` | Suggest skills and tool candidates, repetition, and possible completion to the agent. |
| `act` | In addition to `advise`, apply individually enabled tool activation, call blocking, model routing, and thinking-level selection. |

`enabled: false` disables decisions regardless of mode. An explicitly invoked skill takes precedence over automatic skill suggestions. When Jev finds no suitable candidate or its confidence is too low, the plugin makes no recommendation.

With a valid key and active configuration, `display.startup` shows a one-time UI notice with the mode, model, API origin, key source (never the key itself), enabled decisions, and call limit. It defaults to `true`. `display.decisions` shows each turn's Jev selection and tool-call preflight result; it defaults to `false` because these notices can be frequent, but also works in `shadow` mode. Independently of both options, an active Jev session records input and output tokens and estimated cost for each turn and the session total in UI history. Those records are not sent to the agent model, and the session total continues when a session is reopened. Missing-key and error warnings are shown regardless of display settings.

In `shadow` mode, a `Jev shadow` history card records whether a tool was recommended, the first tool actually used, its first result when recommended, successful test/type-check/build commands in that turn, and consecutive same-tool errors. `/jev-shadow-report` aggregates the current session branch's recommendations, actual use, first-result successes, successful checks after following a recommendation, differing first tools, and repeated-error calls. It recognizes known `bun`/`npm` test, build, and type-check commands; it does not establish that the entire user request was verified. These are observations of `shadow` behavior, not causal evidence that applying Jev would avoid calls or improve outcomes. Skill loading is not included.

Estimated cost uses the API response's `usage.cost` when present. Otherwise it uses the public [TypeSafe Jev 1.13 price](https://docs.typesafe.ai/models) of $0.042 per million input tokens, the [Span-01 price](https://openrouter.ai/respan/span-01) of $0.02 per million input tokens, or the free Span-01 Lite price (output is free). Unknown models show `unavailable`. Failed API requests provide no usage data and cannot be counted.

### Decision scope

Enable only the decisions you need. `skills`, `nextAction`, `toolDiscovery`, `resultAssessment`, `loopDetection`, and `completion` default to `true`; the others default to `false`.

| Setting | Behavior when enabled |
| --- | --- |
| `skills` | Suggest a suitable skill from the loaded skills. |
| `nextAction` | Suggest the next tool from currently available execution tools. `tool_search` is excluded from ordinary execution candidates. |
| `toolDiscovery` | Suggest finding a new tool when `tool_search` is active and existing tools do not fit. Jev does not perform the search. |
| `resultAssessment` | Assess progress from recent tool results. After two consecutive scores below 0.5, point out the recent tool and failure type and suggest seeking evidence with an active tool not used in the last four results. It does not control execution. |
| `loopDetection` | Judge whether recent results repeat a failure and suggest a check or alternative tool based on an observed missing path, permission problem, timeout, HTTP error, or other failure. |
| `completion` | Suggest possible completion evidence only when Jev maps a successful check result ID directly to every numbered or bulleted requirement (or the whole request if there is no list). Unmapped items prompt further verification; the plugin never forces completion. |
| `toolActivation` | In `act` mode, activate only tools listed in `activatableTools`. |
| `toolPreflight` | In `act` mode, block a proposed tool call just before execution when it appears outside the request's scope. |
| `modelRouting` | In `act` mode, select a session model from the available models listed in `models`. |
| `thinkingLevel` | In `act` mode, select the session's thinking level. |

Jev decisions are refreshed not only when a user request starts but also **on agent turns following tool results**. Duplicate decisions for an unchanged state are skipped. The plugin does not replace a call the agent has already selected with another tool call.

### Experimental code search

Set `"experimentalCodeSearch": true` to register `jev_code_search` at session startup for a trusted Git project. It is `false` by default and is not registered in `off` mode or without an API key for the selected decision provider. For example: `jev_code_search({ "query": "Where are expired sessions rejected?", "path": "src" })`. The optional `path` is a directory inside the project. Jev selects relevant files and source ranges; the tool returns paths, line numbers, and verbatim excerpts rather than generating an answer or editing code.

The search considers Git-tracked and unignored source files. It excludes hidden paths, paths that look like credentials, symbolic links, and files over 64 KiB. More than 48 eligible files require a narrower path. It evaluates up to 24 distributed 20-line windows per relevant file, so it may not examine a whole file. **File paths and some source content are sent to the selected decision provider.** Path filtering does not detect secrets inside source files; enable this only in projects whose contents you intend to send.

Enabling `decisions.toolActivation`, `decisions.modelRouting`, or `decisions.thinkingLevel` alongside experimental search causes a configuration error. A search call itself does not change the agent's model, thinking level, or active tool set mid-turn. On hosts with `eval`, the tool is hidden from the model's direct tool list and can be called through `eval`. Start a new session after changing the setting. Use regular `grep` and `read` when you already know the exact symbol or path.

#### Search cost observed in real OmO runs

We tested Jev-first code retrieval with real OmO calls. We gave `openai/gpt-6-sol` the same question tracing behavior across several files in this repository, five times with ordinary search and five times with Jev search. **Both methods found source evidence in all five runs. Including Jev's estimated cost, Jev search cost 19.4% less in this experiment.**

| Five-run total | Ordinary search | Jev search |
| --- | ---: | ---: |
| Host model cost (including cache charges) | $0.327948 | $0.260144 |
| Estimated Jev cost | $0 | $0.004038 |
| **Total cost** | **$0.327948** | **$0.264182** |

Jev cost is estimated from its [published input price](https://docs.typesafe.ai/models). This measurement covers one investigation task in one repository; it does not guarantee savings on other work or preservation of the prompt cache.

Additional options are documented in the [example configuration](./jev-plugin.example.jsonc):

- `provider.selected`: `jev_compatible` or `respan-ai`.
- `provider.jev_compatible`, `provider.respan-ai`: Per-provider `model`, `apiKey`, and `endpoint`. Missing keys come from `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`, respectively; the TypeSafe SDK or OpenRouter supplies the default endpoint.
- `models`: Candidates for `modelRouting` as `["provider/model-id"]`. Only models available in the current session are considered.
- `activatableTools`: Allowlist for `toolActivation`. Empty by default.
- `limits.timeoutMs`, `limits.spanTimeoutMs`, `limits.maxCallsPerAgentRun`, `limits.stateChars`: Jev timeout (default 1,000 ms), Span-01 timeout (default 10,000 ms), maximum calls per agent run (30), and request/result text length (2,000 characters). When one call remains, it prioritizes recovery after a failure, completion-evidence mapping after a successful check, progress assessment after other results, or next action, tool discovery, and skills on an initial turn. It saves a call instead of asking only about completion before a check result exists.
- `thresholds.fit`, `thresholds.confidence`, `thresholds.risk`: Suitability, selection confidence, and blocking thresholds. Defaults: `0.6`, `0.65`, and `0.8`.
- `preflightOnError`: Whether `act` mode should `allow` (the default) or `block` a tool call when preflight fails.
- `skillRerank`: When enabled with at least 24 skills, make an additional Jev request using up to the first 500 characters of each of the three shortlisted `SKILL.md` files. Defaults to `false`; part of each skill file is sent to TypeSafe. Skip reranking when at most two calls remain so later decisions retain budget.
- `redactValues`, `redactPatterns`: Replace specified strings or regex matches with fixed placeholders in requests, tool results, tool arguments, and candidate descriptions sent to Jev. Both default to empty lists. `redactPatterns` contains JavaScript regex bodies; patterns matching an empty string are rejected. If redaction makes candidate names indistinguishable, the suggestion is withheld.

## Data sent and troubleshooting

With the decision API enabled, a truncated user request and recent tool names and success/error status are sent to TypeSafe when Jev is selected, or through OpenRouter to Respan when Span-01 is selected. Skill, tool, and model candidate names and descriptions are also included in questions. With completion enabled, up to six requirements and the IDs, kinds, and tool names of recent successful test/build checks are sent; more than six requirements cannot be marked as fully supported. A behavior check such as `curl --fail` is considered evidence only when `includeToolOutput` is enabled and text from the result is available. Tool output text is not sent by default. `includeToolErrors: true` sends a bounded part of failed tool output only; `includeToolOutput: true` also includes successful results. Result text is limited by `limits.stateChars`, but even an error message can contain secrets. Enabling `toolPreflight` also sends bounded tool arguments. Review the transmitted data for sensitive work.

If an advisory decision request fails, the plugin skips that decision and preserves normal senpi behavior. `preflightOnError` controls whether a failed preflight blocks execution. If the plugin does not work, check the selected provider's API key, `mode`, JSONC warning, and project trust status.

For development and release information, see [CONTRIBUTING.md](./CONTRIBUTING.md).
