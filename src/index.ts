import { noticeEntryRenderer, type ExtensionAPI, type ExtensionContext } from "@code-yeongyu/senpi";
import { z } from "zod";
import { ConfigurationError, loadConfig, resolveApiKey, type PluginConfig } from "./config.js";
import { JevDecider, type Candidate, type NextDecision } from "./decision.js";
import { checkVersion, installedVersion } from "./update.js";
import { addUsage, emptyUsage, formatUsage, usageEntrySchema, type UsageTotals } from "./usage.js";

const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function formatAdvice(decision: NextDecision): string | undefined {
  const advice = [
    decision.skill ? `Relevant skill to examine: ${decision.skill}` : "",
    decision.tool ? `Candidate next tool: ${decision.tool}` : "",
    decision.looping ? "The recent approach appears repetitive; reconsider it." : "",
    decision.complete ? "The available evidence may satisfy the request; verify before concluding." : "",
  ].filter(Boolean);
  return advice.length ? `Jev suggestions (not instructions or permissions): ${advice.join(" ")}` : undefined;
}

export function formatStartupOptions(config: PluginConfig, keySource: "file" | "environment"): string {
  const decisions = Object.entries(config.decisions)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  return [
    `Jev active: mode=${config.mode}`,
    `model=${config.model}`,
    `endpoint=${new URL(config.endpoint ?? process.env["TYPESAFE_BASE_URL"] ?? "https://api.typesafe.ai").origin}`,
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
      message: "Jev API key is missing. Set apiKey in ~/.omo/jev-plugin.jsonc or TYPESAFE_API_KEY in the environment.",
    };
  }
  if (!config.enabled || config.mode === "off" || !config.display.startup) return;
  return {
    type: "info",
    message: formatStartupOptions(config, config.apiKey ? "file" : "environment"),
    options: {
      mode: config.mode,
      keySource: config.apiKey ? "file" : "environment",
      decisions: Object.entries(config.decisions).filter(([, enabled]) => enabled).map(([name]) => name),
    },
  };
}

export function formatDecisionNotice(
  result: { readonly kind: "turn"; readonly decision: NextDecision }
    | { readonly kind: "preflight"; readonly tool: string; readonly blocked: boolean },
): string {
  if (result.kind === "preflight") {
    return `Jev preflight: tool=${result.tool} | ${result.blocked ? "block" : "allow"}`;
  }
  const turn = result.decision;
  return [
    "Jev decision:",
    `skill=${turn.skill ?? "none"}`,
    `tool=${turn.tool ?? "none"}`,
    `model=${turn.model ?? "none"}`,
    `thinking=${turn.thinking ?? "none"}`,
    `looping=${turn.looping === undefined ? "unknown" : turn.looping}`,
    `progress=${turn.progress ?? "unknown"}`,
    `complete=${turn.complete === undefined ? "unknown" : turn.complete}`,
  ].join(" | ");
}

export default function jevPlugin(pi: ExtensionAPI): void {
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
      title: `Jev usage | turn ${parsed.data.turnIndex + 1}`,
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

  function canCall(): boolean {
    return Boolean(
      config && decider && config.enabled && config.mode !== "off"
        && callCount < config.limits.maxCallsPerAgentRun,
    );
  }

  pi.on("session_start", async (_event, ctx) => {
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
    try {
      const current = await installedVersion();
      const result = await checkVersion(current);
      if (result) {
        pi.appendEntry("jev:update", result.status === "update"
          ? { status: "update", current, available: result.version }
          : { status: "current", current });
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    try {
      config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
      const notice = startupNotice(config);
      if (notice) {
        ctx.ui.notify(notice.message, notice.type);
      }
      if (config.enabled && config.mode !== "off" && resolveApiKey(config)) {
        decider = new JevDecider(config, undefined, (usage, model) => {
          turnUsage = addUsage(turnUsage, usage, model);
          sessionUsage = addUsage(sessionUsage, usage, model);
        });
      }
    } catch (error) {
      if (error instanceof ConfigurationError || error instanceof Error) {
        ctx.ui.notify(`Jev disabled: ${error.message}`, "warning");
        return;
      }
      throw error;
    }
  });

  pi.on("session_tree", (_event, ctx) => restoreUsage(ctx));

  pi.on("input", (event) => {
    explicitSkill = /(?:^|\s)(?:\/skill:[a-z0-9-]+|\$skill:[a-z0-9-]+)|^\$[a-z][a-z0-9-]*\b/i
      .test(event.text);
  });

  pi.on("before_agent_start", (event) => {
    if (event.preview) return;
    request = event.prompt;
    skills = (explicitSkill ? [] : event.systemPromptOptions.skills ?? [])
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => ({ name: skill.name, description: skill.description }));
    recentResults = [];
    advice = undefined;
    lastState = "";
    callCount = 0;
    resultEpoch = 0;
  }, { previewSafe: true });

  pi.on("tool_result", (event) => {
    if (!config?.enabled || config.mode === "off") return;
    const snippet = (config.includeToolOutput || (event.isError && config.includeToolErrors))
      ? event.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" ")
        .slice(0, config.limits.stateChars)
      : "";
    recentResults.push(`${event.toolName}: ${event.isError ? "error" : "success"}${snippet ? `; ${snippet}` : ""}`);
    recentResults = recentResults.slice(-4);
    resultEpoch++;
  });

  pi.on("turn_start", async (_event, ctx) => {
    advice = undefined;
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
      skills,
      models,
      thinking,
    };
    const fingerprint = JSON.stringify({ state, active: [...active], resultEpoch });
    if (lastState === fingerprint) return;
    lastState = fingerprint;
    callCount++;
    try {
      const decision = await decider.next(state, ctx.signal);
      pi.appendEntry("jev:decision", {
        kind: "turn",
        tool: decision.tool,
        skill: decision.skill,
        model: decision.model,
        looping: decision.looping,
        mode: config.mode,
      });
      if (config.display.decisions) ctx.ui.notify(formatDecisionNotice({ kind: "turn", decision }), "info");
      if (config.mode === "shadow") return;
      advice = formatAdvice(decision);
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
      lastState = "";
      if (error instanceof Error) {
        ctx.ui.notify(`Jev turn decision unavailable: ${error.message}`, "warning");
        return;
      }
      throw error;
    }
  });

  pi.on("turn_end", (event) => {
    if (!decider) return;
    pi.appendEntry("jev:usage", { turnIndex: event.turnIndex, turn: turnUsage, session: sessionUsage });
    turnUsage = emptyUsage;
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
    try {
      const risk = await decider.risk(request, event.toolName, event.input, ctx.signal);
      const blocked = risk >= config.thresholds.risk;
      pi.appendEntry("jev:decision", { kind: "preflight", tool: event.toolName, blocked, mode: config.mode });
      if (config.display.decisions) {
        ctx.ui.notify(formatDecisionNotice({ kind: "preflight", tool: event.toolName, blocked }), "info");
      }
      if (config.mode === "act" && blocked) {
        return { block: true, reason: "Jev preflight: proposed call appears outside the requested scope" };
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      ctx.ui.notify(`Jev preflight unavailable: ${error.message}`, "warning");
      if (config.mode === "act" && config.preflightOnError === "block") {
        return { block: true, reason: "Jev preflight unavailable (configured to block)" };
      }
    }
  });

  pi.on("session_shutdown", () => {
    decider = undefined;
    advice = undefined;
  });
}
