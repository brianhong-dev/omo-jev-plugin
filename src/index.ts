import { randomUUID } from "node:crypto";
import { noticeEntryRenderer, type ExtensionAPI, type ExtensionContext } from "@code-yeongyu/senpi";
import { Type } from "typebox";
import { z } from "zod";
import { CodeSearchError, searchCode } from "./code-search.js";
import { ConfigurationError, decisionModel, loadConfig, resolveApiKey, type PluginConfig } from "./config.js";
import { JevDecider, redactText, type Candidate, type NextDecision } from "./decision.js";
import { requirementsFromRequest, verificationKind, type VerificationResult } from "./evidence.js";
import { classifyFailure, planRecovery, type Attempt, type FailureKind, type RecoveryPlan } from "./recovery.js";
import { isSuccessfulCheck, replayShadow, shadowFeedbackSchema, type ShadowFeedback } from "./shadow.js";
import { PostHogExporter } from "./posthog.js";
import { TelemetryRecorder, updateInstallationInfo, type InstallationInfo, type TelemetryExporter, type TelemetryMetadata } from "./telemetry.js";
import { checkVersion, installedVersion, updatePlugin } from "./update.js";
import { addUsage, emptyUsage, formatUsage, usageEntrySchema, type UsageTotals } from "./usage.js";

const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const failureAction: Record<FailureKind, string> = {
  "missing-path": "check that the target path exists before retrying",
  permission: "check access to the target before retrying",
  timeout: "check service reachability before retrying",
  http: "inspect the HTTP status and response before retrying",
  other: "inspect the reported error before retrying",
};

function formatAdvice(decision: NextDecision, model: string, recovery?: RecoveryPlan): string | undefined {
  const advice = [
    decision.skill ? `Relevant skill to examine: ${decision.skill}` : "",
    decision.tool ? `Candidate next tool: ${decision.tool}` : "",
    decision.discoverTools ? "Available tools do not fit; use tool_search to discover one." : "",
    decision.looping && !recovery ? "The recent approach appears repetitive; reconsider it." : "",
    recovery?.kind === "failure"
      ? `Recent ${recovery.tool} failure (${recovery.failure ?? "other"}): ${failureAction[recovery.failure ?? "other"]}; ${recovery.alternativeTool
        ? `gather independent evidence with ${recovery.alternativeTool}` : "do not repeat the same call unchanged"}.`
      : recovery?.kind === "stalled"
        ? `Results after ${recovery.tool} show little progress; ${recovery.alternativeTool
          ? `gather independent evidence with ${recovery.alternativeTool}`
          : `compare the last ${recovery.tool} result with an unmet requirement before using it again`}.`
        : "",
    decision.complete
      ? decision.completionEvidence && decision.verifiedRequirements?.length
        ? `The decision model sees possible completion with mapped checks: ${decision.verifiedRequirements.map(({ requirementIndex, result }) =>
          `requirement ${requirementIndex + 1} <- ${result.kind} ${result.tool} (${result.id})`).join(", ")}; verify the evidence before concluding.`
        : `The decision model suggests completion, but only ${decision.verifiedRequirements?.length ?? 0}/${decision.requirementCount ?? 0} requirements have mapped checks; verify the rest.`
      : "",
  ].filter(Boolean);
  return advice.length ? `${model} suggestions (not instructions or permissions): ${advice.join(" ")}` : undefined;
}

export function formatStartupOptions(config: PluginConfig, keySource: "file" | "environment"): string {
  const decisions = Object.entries(config.decisions)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  return [
    `${config.provider.selected === "respan-ai" ? "Span-01" : "Jev"} active: mode=${config.mode}`,
    `model=${decisionModel(config)}`,
    `endpoint=${new URL((config.provider.selected === "respan-ai"
      ? config.provider["respan-ai"].endpoint : config.provider.jev_compatible.endpoint)
      ?? (config.provider.selected === "respan-ai"
      ? "https://openrouter.ai" : process.env["TYPESAFE_BASE_URL"] ?? "https://api.typesafe.ai")).origin}`,
    `key=${keySource}`,
    `decisions=${decisions.length ? decisions.join(",") : "none"}`,
    `maxCalls=${config.limits.maxCallsPerAgentRun}`,
  ].join(" | ");
}

export function startupNotice(
  config: PluginConfig,
  environment = process.env,
): { type: "info" | "warning"; message: string; options?: {
  mode: PluginConfig["mode"];
  keySource: "file" | "environment";
  decisions: string[];
} } | undefined {
  if (!resolveApiKey(config, environment)) {
    return {
      type: "warning",
      message: `Decision API key is missing. Set ${
        config.provider.selected === "respan-ai" ? "provider.respan-ai.apiKey" : "provider.jev_compatible.apiKey"
      } in ~/.omo/jev-plugin.jsonc or ${
        config.provider.selected === "respan-ai" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY"
      } in the environment.`,
    };
  }
  if (!config.enabled || config.mode === "off" || !config.display.startup) return;
  return {
    type: "info",
    message: formatStartupOptions(config, (config.provider.selected === "respan-ai"
      ? config.provider["respan-ai"].apiKey : config.provider.jev_compatible.apiKey)
      ? "file" : "environment"),
    options: {
      mode: config.mode,
      keySource: (config.provider.selected === "respan-ai"
        ? config.provider["respan-ai"].apiKey : config.provider.jev_compatible.apiKey)
        ? "file" : "environment",
      decisions: Object.entries(config.decisions).filter(([, enabled]) => enabled).map(([name]) => name),
    },
  };
}

export function formatDecisionNotice(
  result: { readonly kind: "turn"; readonly decision: NextDecision }
    | { readonly kind: "preflight"; readonly tool: string; readonly blocked: boolean },
  provider: PluginConfig["provider"]["selected"] = "jev_compatible",
): string {
  const label = provider === "respan-ai" ? "Span-01" : "Jev";
  if (result.kind === "preflight") {
    return `${label} preflight: tool=${result.tool} | ${result.blocked ? "block" : "allow"}`;
  }
  const turn = result.decision;
  return [
    `${label} decision:`,
    `skill=${turn.skill ?? "none"}`,
    `tool=${turn.tool ?? "none"}`,
    `discoverTools=${turn.discoverTools === undefined ? "unknown" : turn.discoverTools}`,
    `model=${turn.model ?? "none"}`,
    `thinking=${turn.thinking ?? "none"}`,
    `looping=${turn.looping === undefined ? "unknown" : turn.looping}`,
    `progress=${turn.progress ?? "unknown"}`,
    `complete=${turn.complete === undefined ? "unknown" : turn.complete}`,
    `completionEvidence=${turn.completionEvidence === undefined ? "unknown" : turn.completionEvidence}`,
    `mappedChecks=${turn.verifiedRequirements?.length ?? 0}/${turn.requirementCount ?? 0}`,
    `recoveryTool=${turn.recoveryTool ?? "none"}`,
  ].join(" | ");
}

export default function jevPlugin(
  pi: ExtensionAPI,
  exporter: TelemetryExporter = new PostHogExporter(),
  installUpdate: () => Promise<void> = updatePlugin,
): void {
  const telemetry = new TelemetryRecorder(exporter);
  let installationInfo: InstallationInfo | undefined;
  let usageSessionId: string = randomUUID();
  let config: PluginConfig | undefined;
  let decider: JevDecider | undefined;
  let request = "";
  let skills: Candidate[] = [];
  let recentResults: string[] = [];
  let advice: string | undefined;
  let callCount = 0;
  let lastState = "";
  let explicitSkill = false;
  let resultEpoch = 0;
  let turnUsage: UsageTotals = emptyUsage;
  let sessionUsage: UsageTotals = emptyUsage;
  let shadowFeedback: Omit<ShadowFeedback, "turnIndex"> | undefined;
  let previousErrorTool: string | undefined;
  let lowProgressStreak = 0;
  let requirements: readonly string[] = [];
  let requirementsTruncated = false;
  let verificationResults: VerificationResult[] = [];
  let recentAttempts: Attempt[] = [];
  let searchRegistered = false;
  let reloadPending = false;
  let reloadInFlight = false;

  async function reloadWhenIdle(ctx: ExtensionContext): Promise<void> {
    if (!reloadPending || reloadInFlight || !ctx.requestReload || !ctx.isIdle() || ctx.hasPendingMessages()
      || ctx.isCompacting?.()) return;
    if (ctx.checkReloadVeto && (await ctx.checkReloadVeto()).cancelled) return;
    reloadInFlight = true;
    try {
      await ctx.requestReload();
      reloadPending = false;
    } finally {
      reloadInFlight = false;
    }
  }

  function telemetryMetadata(ctx: ExtensionContext): TelemetryMetadata {
    return {
      omoSessionId: ctx.sessionManager.getSessionId?.() ?? null,
      pluginProvider: config?.provider.selected ?? null,
      pluginModel: config ? decisionModel(config) : null,
      llmModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      thinkingEffort: ctx.thinkingLevel ?? pi.getThinkingLevel?.() ?? null,
    };
  }

  async function recordDecision(
    ctx: ExtensionContext,
    kind: "turn" | "preflight" | "code_search",
    outcome: "success" | "error",
    before: UsageTotals,
    recommendationMade = false,
    blocked: boolean | null = null,
  ): Promise<void> {
    if (!installationInfo || !config?.telemetry.detailed) return;
    const cost = sessionUsage.estimatedCost === null || before.estimatedCost === null
      ? null : sessionUsage.estimatedCost - before.estimatedCost;
    try {
      await telemetry.decision(true, {
        type: "decision_recorded", schemaVersion: 1,
        installationId: installationInfo.installationId,
        pluginVersion: installationInfo.lastPluginVersion,
        ...telemetryMetadata(ctx),
        decisionKind: kind, outcome, recommendationMade, blocked,
        inputTokens: sessionUsage.inputTokens - before.inputTokens,
        outputTokens: sessionUsage.outputTokens - before.outputTokens,
        estimatedCost: cost,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }

  function restoreUsage(ctx: ExtensionContext): void {
    sessionUsage = emptyUsage;
    turnUsage = emptyUsage;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "jev:usage") continue;
      const saved = usageEntrySchema.safeParse(entry.data);
      if (saved.success) sessionUsage = saved.data.session;
    }
  }

  pi.registerEntryRenderer("jev:usage", noticeEntryRenderer((entry) => {
    const parsed = usageEntrySchema.safeParse(entry.data);
    if (!parsed.success) return;
    return {
      title: `Decision usage | turn ${parsed.data.turnIndex + 1}`,
      why: `Turn: ${formatUsage(parsed.data.turn)}`,
      extra: [{ text: `Session: ${formatUsage(parsed.data.session)}` }],
    };
  }));

  pi.registerEntryRenderer("jev:update", noticeEntryRenderer((entry) => {
    const parsed = z.discriminatedUnion("status", [
      z.object({ status: z.literal("current"), current: z.string() }),
      z.object({ status: z.literal("update"), current: z.string(), available: z.string() }),
    ]).safeParse(entry.data);
    if (!parsed.success) return;
    if (parsed.data.status === "current") {
      return {
        title: `omo-jev-plugin ${parsed.data.current} is up to date`,
        why: "No update is available.",
      };
    }
    return {
      title: `omo-jev-plugin ${parsed.data.available} is available`,
      why: `Installed: ${parsed.data.current}. Run omo update npm:omo-jev-plugin to update.`,
    };
  }));

  pi.registerEntryRenderer("jev:feedback", noticeEntryRenderer((entry) => {
    const parsed = shadowFeedbackSchema.safeParse(entry.data);
    if (!parsed.success) return;
    return {
      title: `Jev shadow | turn ${parsed.data.turnIndex + 1}`,
      why: `Suggested ${parsed.data.recommended ?? "none"} | ${parsed.data.followed
        ? `used (${parsed.data.succeeded ? "success" : "error"})` : "not used"} | calls=${parsed.data.toolCalls}`,
    };
  }));

  pi.registerCommand("jev-shadow-report", {
    description: "Replay observed shadow recommendations and tool results in this session",
    handler: async (_args, ctx) => {
      const report = replayShadow(ctx.sessionManager.getBranch());
      ctx.ui.notify(
        `Jev shadow replay: turns=${report.turns} | recommended=${report.recommended}`
        + ` | followed=${report.followed} | first-result-success=${report.successful}`
        + ` | successful-check-after-following=${report.checksAfterFollowed}`
        + ` | first-tool-differences=${report.baselineDifferences}`
        + ` | repeated-error-calls=${report.repeatedErrors}`
        + " (observations only; not a causal comparison with act)",
        "info",
      );
    },
  });

  function canCall(): boolean {
    return Boolean(
      config && decider && config.enabled && config.mode !== "off"
        && callCount < config.limits.maxCallsPerAgentRun,
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    reloadPending = false;
    installationInfo = undefined;
    usageSessionId = ctx.sessionManager.getSessionId?.() || randomUUID();
    restoreUsage(ctx);
    config = undefined;
    decider = undefined;
    advice = undefined;
    request = "";
    skills = [];
    recentResults = [];
    lastState = "";
    callCount = 0;
    resultEpoch = 0;
    shadowFeedback = undefined;
    previousErrorTool = undefined;
    lowProgressStreak = 0;
    requirements = [];
    requirementsTruncated = false;
    verificationResults = [];
    recentAttempts = [];
    try {
      const version = await installedVersion();
      const info = await updateInstallationInfo(version);
      installationInfo = info;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      ctx.ui.notify(`Jev installation information unavailable: ${error.message}`, "warning");
    }
    try {
      config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
      const current = await installedVersion();
      const result = await checkVersion(current);
      if (result) {
        pi.appendEntry("jev:update", result.status === "update"
          ? { status: "update", current, available: result.version }
          : { status: "current", current });
      }
      if (config.autoUpdate && result?.status === "update") {
        if (!ctx.requestReload) {
          ctx.ui.notify("Jev automatic update requires a host with session reload support.", "warning");
        } else {
          try {
            await installUpdate();
            reloadPending = true;
            ctx.ui.notify(`omo-jev-plugin ${result.version} installed; reloading the session.`, "info");
            setImmediate(() => {
              void reloadWhenIdle(ctx).catch((error: unknown) => {
                if (!(error instanceof Error)) throw error;
                ctx.ui.notify(`Jev session reload failed: ${error.message}`, "warning");
              });
            });
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            ctx.ui.notify(`Jev automatic update failed: ${error.message}`, "warning");
          }
        }
      }
      const notice = startupNotice(config);
      if (notice) {
        ctx.ui.notify(notice.message, notice.type);
      }
      if (config.enabled && config.mode !== "off" && resolveApiKey(config)) {
        decider = new JevDecider(config, undefined, (usage, model) => {
          turnUsage = addUsage(turnUsage, usage, model);
          sessionUsage = addUsage(sessionUsage, usage, model);
        }, () => { callCount++; });
      }
      if (decider && config.experimentalCodeSearch && ctx.isProjectTrusted()) {
        if (!searchRegistered) {
          pi.registerTool({
            name: "jev_code_search",
            label: "Jev Code Search (experimental)",
            description: "Find relevant source in this trusted Git project by behavior; returns bounded verbatim excerpts and paths.",
            exposure: "eval",
            allowLazyActivation: false,
            parameters: Type.Object({
              query: Type.String({ minLength: 1, maxLength: 500 }),
              path: Type.Optional(Type.String({ description: "Relative project directory to narrow the search" })),
            }),
            async execute(_id, params, signal, _onUpdate, toolCtx) {
              if (!toolCtx.isProjectTrusted() || !canCall() || !config?.experimentalCodeSearch || !decider) {
                return { content: [{ type: "text", text: "Jev code search is unavailable for this session." }], details: {} };
              }
              if (config.limits.maxCallsPerAgentRun - callCount < 2) {
                return { content: [{ type: "text", text: "Jev code search needs two remaining decision calls." }], details: {} };
              }
              const currentDecider = decider;
              const before = sessionUsage;
              try {
                const text = await searchCode({
                  cwd: toolCtx.cwd, query: params.query, scope: params.path, signal,
                }, (query, candidates, searchSignal) => currentDecider.rankCode(query, candidates, searchSignal));
                await recordDecision(toolCtx, "code_search", "success", before);
                return { content: [{ type: "text", text }], details: {} };
              } catch (error) {
                await recordDecision(toolCtx, "code_search", "error", before);
                if (!(error instanceof CodeSearchError)) throw error;
                return { content: [{ type: "text", text: error.message }], details: {} };
              }
            },
          });
          searchRegistered = true;
        } else if (!pi.getActiveTools().includes("jev_code_search")) {
          pi.setActiveTools([...pi.getActiveTools(), "jev_code_search"]);
        }
      } else if (searchRegistered && pi.getActiveTools().includes("jev_code_search")) {
        pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "jev_code_search"));
      }
    } catch (error) {
      if (error instanceof ConfigurationError || error instanceof Error) {
        ctx.ui.notify(`Jev disabled: ${error.message}`, "warning");
        return;
      }
      throw error;
    } finally {
      if (installationInfo && config?.enabled) {
        try {
          await telemetry.sessionStarted(installationInfo, telemetryMetadata(ctx));
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
      }
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      await reloadWhenIdle(ctx);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      ctx.ui.notify(`Jev session reload failed: ${error.message}`, "warning");
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreUsage(ctx);
    verificationResults = [];
    recentAttempts = [];
    lastState = "";
  });

  pi.on("input", (event) => {
    explicitSkill = /(?:^|\s)(?:\/skill:[a-z0-9-]+|\$skill:[a-z0-9-]+)|^\$[a-z][a-z0-9-]*\b/i
      .test(event.text);
  });

  pi.on("before_agent_start", (event) => {
    if (event.preview) return;
    request = event.prompt;
    const extracted = requirementsFromRequest(request);
    requirements = extracted.items;
    requirementsTruncated = extracted.truncated;
    skills = (explicitSkill ? [] : event.systemPromptOptions.skills ?? [])
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.filePath }));
    recentResults = [];
    advice = undefined;
    lastState = "";
    callCount = 0;
    resultEpoch = 0;
    shadowFeedback = undefined;
    previousErrorTool = undefined;
    lowProgressStreak = 0;
    verificationResults = [];
    recentAttempts = [];
  }, { previewSafe: true });

  pi.on("tool_result", (event) => {
    if (!config?.enabled || config.mode === "off") return;
    const diagnostic = event.isError
      ? event.content.filter((part) => part.type === "text").map((part) => part.text).join(" ").slice(0, 512) : "";
    recentAttempts.push({
      tool: event.toolName,
      failed: event.isError,
      ...(event.isError ? { failure: classifyFailure(diagnostic) } : {}),
    });
    recentAttempts = recentAttempts.slice(-4);
    if (shadowFeedback) {
      shadowFeedback.toolCalls++;
      shadowFeedback.firstTool ??= event.toolName;
      if (event.isError && previousErrorTool === event.toolName) shadowFeedback.repeatedErrors++;
      previousErrorTool = event.isError ? event.toolName : undefined;
      if (!shadowFeedback.followed && event.toolName === shadowFeedback.recommended) {
        shadowFeedback.followed = true;
        shadowFeedback.succeeded = !event.isError;
      }
      if (shadowFeedback.followed && isSuccessfulCheck(event.toolName, event.input, event.isError)) {
        shadowFeedback.checkSucceeded = true;
      }
    }
    const snippet = (config.includeToolOutput || (event.isError && config.includeToolErrors))
      ? redactText(event.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" "), config)
        .slice(0, config.limits.stateChars)
      : "";
    const kind = verificationKind(event.toolName, event.input);
    if (kind && event.isError) verificationResults = [];
    if (kind && !event.isError && (kind !== "behavior" || (config.includeToolOutput && snippet))) {
      verificationResults.push({
        id: event.toolCallId, tool: event.toolName, kind,
        ...(kind === "behavior" ? { detail: snippet } : {}),
      });
      verificationResults = verificationResults.slice(-4);
    }
    recentResults.push(`${event.toolName}: ${event.isError ? "error" : "success"}${snippet ? `; ${snippet}` : ""}`);
    recentResults = recentResults.slice(-4);
    resultEpoch++;
  });

  pi.on("turn_start", async (_event, ctx) => {
    advice = undefined;
    shadowFeedback = undefined;
    previousErrorTool = undefined;
    if (!canCall() || !config || !decider) return;
    const active = new Set(pi.getActiveTools());
    const tools = pi.getAllTools()
      .filter((tool) => active.has(tool.name) || (
        config?.mode === "act" && config.decisions.toolActivation
          && config.activatableTools.includes(tool.name)
      ))
      .map((tool) => ({ name: tool.name, description: tool.description }));
    const models = ctx.modelRegistry.getAvailable()
      .filter((model) => config?.models.includes(`${model.provider}/${model.id}`))
      .map((model) => ({
        name: `${model.provider}/${model.id}`,
        description: model.name,
      }));
    const thinking = thinkingSchema.options.map((name) => ({ name, description: name }));
    const state = {
      request,
      lastResults: recentResults,
      tools,
      activeTools: [...active],
      canDiscoverTools: active.has("tool_search"),
      requirements,
      requirementsTruncated,
      verificationResults,
      attempts: recentAttempts,
      skills,
      models,
      thinking,
    };
    const fingerprint = JSON.stringify({ state, active: [...active], resultEpoch });
    if (lastState === fingerprint) return;
    lastState = fingerprint;
    const before = sessionUsage;
    try {
      const decision = await decider.next(state, ctx.signal, config.limits.maxCallsPerAgentRun - callCount);
      await recordDecision(ctx, "turn", "success", before, Boolean(decision.tool || decision.skill || decision.model));
      const nextLowProgressStreak = decision.progress !== undefined && decision.progress < 0.5
        ? lowProgressStreak + 1 : 0;
      const recovery = config.mode === "shadow" ? undefined
        : planRecovery(nextLowProgressStreak >= 2 || decision.looping === true, recentAttempts, decision.recoveryTool);
      pi.appendEntry("jev:decision", {
        kind: "turn",
        tool: decision.tool,
        discoverTools: decision.discoverTools,
        completionEvidence: decision.completionEvidence,
        verifiedRequirements: decision.verifiedRequirements?.map(({ requirementIndex, result }) => ({
          requirementIndex, resultId: result.id, kind: result.kind, tool: result.tool,
        })),
        recovery,
        skill: decision.skill,
        model: decision.model,
        looping: decision.looping,
        mode: config.mode,
      });
      if (config.display.decisions) ctx.ui.notify(formatDecisionNotice({ kind: "turn", decision }, config.provider.selected), "info");
      if (config.mode === "shadow") {
        shadowFeedback = { ...(decision.tool ? { recommended: decision.tool } : {}),
          followed: false, toolCalls: 0, repeatedErrors: 0, checkSucceeded: false };
        return;
      }
      lowProgressStreak = nextLowProgressStreak;
      advice = formatAdvice(decision, decisionModel(config), recovery);
      if (config.mode !== "act") return;
      if (config.decisions.toolActivation && decision.tool
        && config.activatableTools.includes(decision.tool) && !active.has(decision.tool)) {
        pi.setActiveTools([...active, decision.tool]);
      }
      if (config.decisions.modelRouting && decision.model) {
        const selected = ctx.modelRegistry.getAvailable()
          .find((model) => `${model.provider}/${model.id}` === decision.model);
        if (selected && `${ctx.model?.provider}/${ctx.model?.id}` !== decision.model) {
          await pi.setSessionModel(selected);
        }
      }
      if (config.decisions.thinkingLevel && decision.thinking) {
        const level = thinkingSchema.safeParse(decision.thinking);
        if (level.success && pi.getThinkingLevel() !== level.data) {
          pi.setSessionThinkingLevel(level.data);
        }
      }
    } catch (error) {
      await recordDecision(ctx, "turn", "error", before);
      lastState = "";
      if (error instanceof Error) {
        ctx.ui.notify(`${config.provider.selected === "respan-ai" ? "Span-01" : "Jev"} turn decision unavailable: ${error.message}`, "warning");
        return;
      }
      throw error;
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (config?.mode === "shadow" && shadowFeedback) {
      pi.appendEntry("jev:feedback", { turnIndex: event.turnIndex, ...shadowFeedback });
      shadowFeedback = undefined;
    }
    if (decider) {
      pi.appendEntry("jev:usage", { turnIndex: event.turnIndex, turn: turnUsage, session: sessionUsage });
      if (installationInfo && config?.enabled && config.telemetry.detailed
        && (turnUsage.inputTokens !== 0 || turnUsage.outputTokens !== 0 || turnUsage.estimatedCost !== 0)) {
        try {
          await telemetry.turnUsage(true, {
            type: "turn_usage", schemaVersion: 1,
            installationId: installationInfo.installationId,
            pluginVersion: installationInfo.lastPluginVersion,
            usageSessionId, eventId: randomUUID(), turnIndex: event.turnIndex,
            ...telemetryMetadata(ctx),
            ...turnUsage,
          });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
      }
      turnUsage = emptyUsage;
    }
    try {
      await telemetry.flush();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  });

  pi.on("context", (event) => {
    if (!config || config.mode === "shadow" || config.mode === "off" || !advice) return;
    return {
      messages: [...event.messages, {
        role: "custom",
        customType: "jev:advice",
        content: advice,
        display: false,
        timestamp: Date.now(),
      }],
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!canCall() || !config?.decisions.toolPreflight || !decider) return;
    callCount++;
    const before = sessionUsage;
    try {
      const risk = await decider.risk(request, event.toolName, event.input, ctx.signal);
      const blocked = risk >= config.thresholds.risk;
      await recordDecision(ctx, "preflight", "success", before, false, blocked);
      pi.appendEntry("jev:decision", { kind: "preflight", tool: event.toolName, blocked, mode: config.mode });
      if (config.display.decisions) {
        ctx.ui.notify(formatDecisionNotice({ kind: "preflight", tool: event.toolName, blocked }, config.provider.selected), "info");
      }
      if (config.mode === "act" && blocked) {
        return { block: true, reason: "Decision preflight: proposed call appears outside the requested scope" };
      }
    } catch (error) {
      await recordDecision(ctx, "preflight", "error", before);
      if (!(error instanceof Error)) throw error;
      ctx.ui.notify(`${config.provider.selected === "respan-ai" ? "Span-01" : "Jev"} preflight unavailable: ${error.message}`, "warning");
      if (config.mode === "act" && config.preflightOnError === "block") {
        return { block: true, reason: "Decision preflight unavailable (configured to block)" };
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (installationInfo && config?.enabled && config.telemetry.detailed) {
      try {
        await telemetry.sessionSummary(true, {
          type: "session_summary", schemaVersion: 2,
          installationId: installationInfo.installationId,
          pluginVersion: installationInfo.lastPluginVersion,
          mode: config.mode, provider: config.provider.selected,
          ...telemetryMetadata(ctx),
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
    }
    try {
      await telemetry.flush();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    decider = undefined;
    advice = undefined;
  });
}
