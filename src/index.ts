import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { z } from "zod";
import { ConfigurationError, loadConfig, type PluginConfig } from "./config.js";
import { JevDecider, type Candidate, type NextDecision } from "./decision.js";

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

  function canCall(): boolean {
    return Boolean(
      config && decider && config.enabled && config.mode !== "off"
        && callCount < config.limits.maxCallsPerAgentRun,
    );
  }

  pi.on("session_start", async (_event, ctx) => {
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
      config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
      if (config.enabled && config.mode !== "off") decider = new JevDecider(config);
    } catch (error) {
      if (error instanceof ConfigurationError || error instanceof Error) {
        ctx.ui.notify(`Jev disabled: ${error.message}`, "warning");
        return;
      }
      throw error;
    }
  });

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
    const snippet = config.includeToolOutput
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
