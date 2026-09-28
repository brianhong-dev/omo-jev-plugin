import { TypeSafeClient, type Questions, type Usage } from "@typesafe-ai/sdk";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { decisionModel, resolveApiKey, type PluginConfig } from "./config.js";
import type { VerificationResult } from "./evidence.js";
import type { Attempt } from "./recovery.js";

export type Candidate = { readonly name: string; readonly description: string; readonly filePath?: string };
export function redactText(text: string, config: PluginConfig): string {
  let result = text;
  for (const { index, value } of config.redactValues
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value.length - a.value.length)) {
    result = result.replaceAll(value, `__JEV_REDACTED_${index}__`);
  }
  for (const [index, pattern] of config.redactPatterns.entries()) {
    result = result.replace(new RegExp(pattern, "g"), `__JEV_REDACTED_${config.redactValues.length + index}__`);
  }
  return result;
}

function redactJson(value: unknown, config: PluginConfig): unknown {
  if (typeof value === "string") return redactText(value, config);
  if (Array.isArray(value)) return value.map((item: unknown) => redactJson(item, config));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
      [redactText(key, config), redactJson(entry, config)]));
  }
  return value;
}
export type NextState = {
  readonly request: string;
  readonly lastResults: readonly string[];
  readonly tools: readonly Candidate[];
  readonly activeTools: readonly string[];
  readonly canDiscoverTools: boolean;
  readonly requirements: readonly string[];
  readonly requirementsTruncated: boolean;
  readonly verificationResults: readonly VerificationResult[];
  readonly attempts: readonly Attempt[];
  readonly skills: readonly Candidate[];
  readonly models: readonly Candidate[];
  readonly thinking: readonly Candidate[];
};

const probability = z.number().min(0).max(1);
const choiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: probability.optional(),
  probabilities: z.record(z.string(), probability),
});
const noulAnswer = z.object({ type: z.literal("noul"), noul: probability });
const scoreAnswer = z.object({ type: z.literal("score"), score: z.number() });
const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional(),
  }),
});

class DecisionHTTPError extends Error {
  constructor(readonly status: number) {
    super(`OpenRouter decisions request failed with HTTP ${status}`);
  }
}

export type NextDecision = {
  readonly tool?: string;
  readonly discoverTools?: boolean;
  readonly recoveryTool?: string;
  readonly skill?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly looping?: boolean;
  readonly progress?: number;
  readonly complete?: boolean;
  readonly completionEvidence?: boolean;
  readonly verifiedRequirements?: readonly {
    readonly requirementIndex: number;
    readonly result: VerificationResult;
  }[];
  readonly requirementCount?: number;
};

function select(
  answers: Record<string, unknown>,
  key: string,
  candidates: readonly Candidate[],
  config: PluginConfig,
): string | undefined {
  const result = choiceAnswer.safeParse(answers[key]);
  const fit = noulAnswer.safeParse(answers[`${key}Fits`]);
  if (!result.success || !fit.success) return;
  const { choice, probabilities } = result.data;
  const matching = candidates.filter(({ name }) => redactText(name, config) === choice);
  if (choice === "__none__" || matching.length !== 1) return;
  const selectedProbability = probabilities[choice];
  if (selectedProbability === undefined || (result.data.confidence ?? selectedProbability) < config.thresholds.confidence
    || fit.data.noul < config.thresholds.fit) return;
  return matching[0]?.name;
}

function addChoice(questions: Questions, key: string, candidates: readonly Candidate[], config: PluginConfig): void {
  if (candidates.length === 0) return;
  const criteria: Record<string, string> = { __none__: "None of these options is appropriate" };
  for (const candidate of candidates.slice(0, 254)) {
    if (candidate.name !== "__none__") {
      criteria[redactText(candidate.name, config)] = redactText(candidate.description, config);
    }
  }
  questions[key] = { type: "choice", instructions: `Which ${key} best serves the current task?`, criteria };
  questions[`${key}Fits`] = {
    type: "noul",
    instructions: `Is any listed ${key} actually appropriate for the current task?`,
  };
}

export class JevDecider {
  private readonly client: TypeSafeClient | undefined;

  constructor(
    private readonly config: PluginConfig,
    client?: TypeSafeClient,
    private readonly onUsage?: (usage: Usage & { readonly cost?: number | undefined }, model: string) => void,
    private readonly onRequest?: () => void,
  ) {
    const apiKey = resolveApiKey(config);
    this.client = config.provider.selected === "respan-ai" ? undefined : client ?? new TypeSafeClient({
      ...(apiKey ? { apiKey } : {}),
      ...(config.provider.jev_compatible.endpoint ? { baseURL: config.provider.jev_compatible.endpoint } : {}),
      defaultModel: decisionModel(config),
      timeout: config.limits.timeoutMs,
      retry: { maxRetries: 0 },
      logLevel: "off",
    });
  }

  private async decide(
    state: Record<string, string | string[]>,
    questions: Questions,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof responseSchema>> {
    if (this.config.provider.selected === "jev_compatible") {
      if (!this.client) throw new Error("TypeSafe client is unavailable");
      return responseSchema.parse(await this.client.systemOne({ state, questions }, signal ? { signal } : {}));
    }
    const adapted: Questions = {};
    const branches = new Map<string, string[]>();
    for (const [name, question] of Object.entries(questions)) {
      if (question.type === "noul") {
        adapted[name] = question;
        continue;
      }
      const labels = question.type === "choice" ? Object.keys(question.criteria)
        : question.criteria.map((_description, index) => String(index));
      branches.set(name, labels);
      for (const [index, label] of labels.entries()) {
        const description = question.type === "choice" ? question.criteria[label] : question.criteria[index];
        adapted[`${name}__${index}`] = {
          type: "noul",
          instructions: `${String(question.instructions ?? "")}\nDoes this option apply: ${label} — ${String(description ?? "")}?`,
          criteria: { true: "This option applies", false: "This option does not apply" },
        };
      }
    }
    const response = await fetch(new URL("/api/alpha/decisions",
      this.config.provider["respan-ai"].endpoint ?? "https://openrouter.ai"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolveApiKey(this.config)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: decisionModel(this.config), state: JSON.stringify(state), questions: adapted }),
      signal: AbortSignal.any([
        AbortSignal.timeout(this.config.limits.spanTimeoutMs),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) throw new DecisionHTTPError(response.status);
    const result = responseSchema.parse(await response.json());
    const answers = { ...result.answers };
    for (const [name, labels] of branches) {
      const values = labels.map((_label, index) => noulAnswer.safeParse(answers[`${name}__${index}`]));
      for (const index of labels.keys()) delete answers[`${name}__${index}`];
      if (values.some((value) => !value.success)) continue;
      const probabilities = Object.fromEntries(labels.map((label, index) =>
        [label, values[index]?.data?.noul ?? 0]));
      const question = questions[name];
      if (question?.type === "choice") {
        const winner = labels.reduce((best, label) =>
          (probabilities[label] ?? 0) > (probabilities[best] ?? 0) ? label : best);
        answers[name] = {
          type: "choice", choice: winner,
          confidence: probabilities[winner], probabilities,
        };
      } else if (question?.type === "score") {
        const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
        if (total > 0) {
          answers[name] = {
            type: "score",
            score: labels.reduce((sum, _label, index) => sum + index * (values[index]?.data?.noul ?? 0), 0) / total,
          };
        }
      }
    }
    return { ...result, answers };
  }

  async rankCode(
    query: string,
    candidates: readonly Candidate[],
    signal?: AbortSignal,
  ): Promise<readonly number[]> {
    const questions: Questions = {};
    for (const [index, candidate] of candidates.entries()) {
      questions[`source${index}`] = {
        type: "noul",
        instructions: `Is this source relevant to the requested behavior? Path: ${redactText(candidate.name, this.config)}
Source: ${redactText(candidate.description, this.config)}`,
      };
    }
    if (candidates.length === 0) return [];
    this.onRequest?.();
    const result = await this.decide({
      request: redactText(query, this.config).slice(0, this.config.limits.stateChars),
    }, questions, signal);
    this.onUsage?.(result.usage, result.model);
    return candidates.map((_candidate, index) => ({
      index,
      probability: noulAnswer.safeParse(result.answers[`source${index}`]).data?.noul ?? 0,
    }))
      .filter(({ probability }) => probability >= this.config.thresholds.fit)
      .sort((a, b) => b.probability - a.probability || a.index - b.index)
      .slice(0, 3)
      .map(({ index }) => index);
  }

  async next(state: NextState, signal?: AbortSignal, availableCalls?: number): Promise<NextDecision> {
    const remaining = availableCalls ?? this.config.limits.maxCallsPerAgentRun;
    if (remaining <= 0) return {};
    const questions: Questions = {};
    if (this.config.decisions.nextAction) {
      addChoice(questions, "tool", state.tools.filter(({ name }) => name !== "tool_search"), this.config);
    }
    if (this.config.decisions.toolDiscovery && state.canDiscoverTools) {
      questions["discoverTools"] = {
        type: "noul",
        instructions: "Are the available tools insufficient for the task, so tool_search should discover a better tool?",
      };
    }
    if ((this.config.decisions.resultAssessment || this.config.decisions.loopDetection)
      && state.lastResults.length > 0) {
      const attempted = new Set(state.attempts.map(({ tool }) => tool));
      addChoice(questions, "recoveryTool", state.tools.filter(({ name }) =>
        state.activeTools.includes(name) && name !== "tool_search" && !attempted.has(name)), this.config);
    }
    if (this.config.decisions.skills) addChoice(questions, "skill", state.skills, this.config);
    if (this.config.decisions.modelRouting) addChoice(questions, "model", state.models, this.config);
    if (this.config.decisions.thinkingLevel) addChoice(questions, "thinking", state.thinking, this.config);
    if (state.lastResults.length > 0) {
      if (this.config.decisions.loopDetection) {
        questions["looping"] = {
          type: "noul",
          instructions: "Are the recent actions repeating the same unsuccessful approach?",
        };
      }
      if (this.config.decisions.resultAssessment) {
        questions["progress"] = {
          type: "score",
          instructions: "How much progress toward the request do the recent results show?",
          criteria: ["None or regression", "Some progress", "Substantial progress"],
        };
      }
    }
    if (this.config.decisions.completion) {
      questions["complete"] = {
        type: "noul",
        instructions: "Is the user's request fully satisfied by the observed work?",
      };
      for (const [index] of state.requirements.entries()) {
        addChoice(questions, `verify${index}`, state.verificationResults.map((result) => ({
          name: result.id,
          description: `${result.kind} succeeded via ${result.tool}${result.detail ? `: ${result.detail}` : ""}`,
        })), this.config);
      }
    }
    if (remaining === 1) {
      let priority: string[] = [];
      if (state.attempts.at(-1)?.failed && (questions["progress"] || questions["looping"])) {
        priority = ["progress", "looping", "recoveryTool", "recoveryToolFits"];
      } else if (state.verificationResults.length > 0 && questions["complete"]) {
        priority = ["complete", ...Object.keys(questions).filter((key) => /^verify\d+(Fits)?$/.test(key))];
      } else if (state.lastResults.length > 0 && (questions["progress"] || questions["looping"])) {
        priority = ["progress", "looping", "recoveryTool", "recoveryToolFits"];
      } else if (questions["tool"]) {
        priority = ["tool", "toolFits"];
      } else if (questions["discoverTools"]) {
        priority = ["discoverTools"];
      } else if (questions["skill"]) {
        priority = ["skill", "skillFits"];
      } else if (questions["model"]) {
        priority = ["model", "modelFits"];
      } else if (questions["thinking"]) {
        priority = ["thinking", "thinkingFits"];
      }
      for (const key of Object.keys(questions)) {
        if (!priority.includes(key)) delete questions[key];
      }
    }
    if (Object.keys(questions).length === 0) return {};
    this.onRequest?.();
    const result = await this.decide(
      {
        request: redactText(state.request, this.config).slice(0, this.config.limits.stateChars),
        lastResults: state.lastResults.map((item) =>
          redactText(item, this.config).slice(0, this.config.limits.stateChars)),
        ...(questions["discoverTools"] ? {
          availableTools: state.tools.filter(({ name }) => name !== "tool_search")
            .slice(0, 254).map(({ name }) => redactText(name, this.config)),
        } : {}),
        ...(questions["complete"] ? {
          requirements: state.requirements.map((item) =>
            redactText(item, this.config).slice(0, this.config.limits.stateChars)),
        } : {}),
      },
      questions,
      signal,
    );
    this.onUsage?.(result.usage, result.model);
    const answers = result.answers;
    const looping = noulAnswer.safeParse(questions["looping"] ? answers["looping"] : undefined);
    const progress = scoreAnswer.safeParse(questions["progress"] ? answers["progress"] : undefined);
    const complete = noulAnswer.safeParse(questions["complete"] ? answers["complete"] : undefined);
    const verifiedRequirements = state.requirements.flatMap((_requirement, index) => {
      if (!questions[`verify${index}`]) return [];
      const id = select(answers, `verify${index}`, state.verificationResults.map((result) => ({
        name: result.id,
        description: result.kind,
      })), this.config);
      const result = state.verificationResults.find((item) => item.id === id);
      return result ? [{ requirementIndex: index, result }] : [];
    });
    const tool = questions["tool"] ? select(answers, "tool",
      state.tools.filter(({ name }) => name !== "tool_search"), this.config) : undefined;
    const discoverTools = noulAnswer.safeParse(questions["discoverTools"] ? answers["discoverTools"] : undefined);
    const attempted = new Set(state.attempts.map(({ tool }) => tool));
    const recoveryTool = questions["recoveryTool"] ? select(answers, "recoveryTool",
      state.tools.filter(({ name }) => state.activeTools.includes(name)
        && name !== "tool_search" && !attempted.has(name)), this.config) : undefined;
    let skill = questions["skill"] ? select(answers, "skill", state.skills, this.config) : undefined;
    if (skill && this.config.skillRerank && remaining >= 3 && state.skills.length >= 24) {
      const ranked = choiceAnswer.safeParse(answers["skill"]);
      if (ranked.success) {
        const shortlist = Object.entries(ranked.data.probabilities)
          .filter(([name]) => state.skills.some((candidate) => redactText(candidate.name, this.config) === name))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .flatMap(([name]) => state.skills.filter((candidate) =>
            redactText(candidate.name, this.config) === name));
        const detailed = await Promise.all(shortlist.map(async (candidate) => ({
          name: candidate.name,
          description: candidate.filePath
            ? `${candidate.description}\n${redactText(await readFile(candidate.filePath, "utf8"), this.config).slice(0, 500)}`
            : candidate.description,
        })));
        const rerankQuestions: Questions = {};
        addChoice(rerankQuestions, "skill", detailed, this.config);
        this.onRequest?.();
        const reranked = await this.decide(
          { request: redactText(state.request, this.config).slice(0, this.config.limits.stateChars) },
          rerankQuestions,
          signal,
        );
        this.onUsage?.(reranked.usage, reranked.model);
        skill = select(reranked.answers, "skill", detailed, this.config);
      }
    }
    const model = questions["model"] ? select(answers, "model", state.models, this.config) : undefined;
    const thinking = questions["thinking"] ? select(answers, "thinking", state.thinking, this.config) : undefined;
    return {
      ...(tool ? { tool } : {}),
      ...(discoverTools.success ? { discoverTools: !tool && discoverTools.data.noul >= this.config.thresholds.fit } : {}),
      ...(recoveryTool ? { recoveryTool } : {}),
      ...(skill ? { skill } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(looping.success ? { looping: looping.data.noul >= this.config.thresholds.risk } : {}),
      ...(progress.success ? { progress: progress.data.score } : {}),
      ...(complete.success ? { complete: complete.data.noul >= this.config.thresholds.fit } : {}),
      ...(questions["complete"] ? {
        completionEvidence: state.requirements.length > 0 && !state.requirementsTruncated
          && verifiedRequirements.length === state.requirements.length,
        verifiedRequirements,
        requirementCount: state.requirements.length,
      } : {}),
    };
  }

  async risk(
    request: string,
    tool: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<number> {
    const response = await this.decide(
      {
        request: redactText(request, this.config).slice(0, this.config.limits.stateChars),
        tool: redactText(tool, this.config),
        input: JSON.stringify(redactJson(JSON.parse(JSON.stringify(input)), this.config))
          .slice(0, this.config.limits.stateChars),
      },
      {
        outsideScope: {
          type: "noul",
          instructions: "Would this tool call act outside the user's requested scope?",
        },
      },
      signal,
    );
    this.onUsage?.(response.usage, response.model);
    return noulAnswer.parse(response.answers["outsideScope"]).noul;
  }
}
