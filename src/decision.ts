import { TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import { z } from "zod";
import type { PluginConfig } from "./config.js";

export type Candidate = { readonly name: string; readonly description: string };
export type NextState = {
  readonly request: string;
  readonly lastResults: readonly string[];
  readonly tools: readonly Candidate[];
  readonly skills: readonly Candidate[];
  readonly models: readonly Candidate[];
  readonly thinking: readonly Candidate[];
};

const probability = z.number().min(0).max(1);
const choiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: probability,
  probabilities: z.record(z.string(), probability),
});
const noulAnswer = z.object({ type: z.literal("noul"), noul: probability });
const scoreAnswer = z.object({ type: z.literal("score"), score: z.number() });
const responseSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
});

export type NextDecision = {
  readonly tool?: string;
  readonly skill?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly looping?: boolean;
  readonly progress?: number;
  readonly complete?: boolean;
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
  const { choice, confidence, probabilities } = result.data;
  if (choice === "__none__" || !candidates.some(({ name }) => name === choice)) return;
  if (confidence < config.thresholds.confidence || fit.data.noul < config.thresholds.fit) return;
  if (probabilities[choice] === undefined) return;
  return choice;
}

function addChoice(questions: Questions, key: string, candidates: readonly Candidate[]): void {
  if (candidates.length === 0) return;
  const criteria: Record<string, string> = { __none__: "None of these options is appropriate" };
  for (const candidate of candidates.slice(0, 254)) {
    if (candidate.name !== "__none__") criteria[candidate.name] = candidate.description;
  }
  questions[key] = { type: "choice", instructions: `Which ${key} best serves the current task?`, criteria };
  questions[`${key}Fits`] = {
    type: "noul",
    instructions: `Is any listed ${key} actually appropriate for the current task?`,
  };
}

export class JevDecider {
  private readonly client: TypeSafeClient;

  constructor(private readonly config: PluginConfig, client?: TypeSafeClient) {
    this.client = client ?? new TypeSafeClient({
      defaultModel: config.model,
      timeout: config.limits.timeoutMs,
      retry: { maxRetries: 0 },
      logLevel: "off",
    });
  }

  async next(state: NextState, signal?: AbortSignal): Promise<NextDecision> {
    const questions: Questions = {};
    if (this.config.decisions.nextAction || this.config.decisions.toolDiscovery) {
      addChoice(questions, "tool", state.tools);
    }
    if (this.config.decisions.skills) addChoice(questions, "skill", state.skills);
    if (this.config.decisions.modelRouting) addChoice(questions, "model", state.models);
    if (this.config.decisions.thinkingLevel) addChoice(questions, "thinking", state.thinking);
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
    }
    if (Object.keys(questions).length === 0) return {};
    const result = responseSchema.parse(await this.client.systemOne({
      state: {
        request: state.request.slice(0, this.config.limits.stateChars),
        lastResults: state.lastResults.map((item) => item.slice(0, this.config.limits.stateChars)),
      },
      questions,
    }, signal ? { signal } : {}));
    const answers = result.answers;
    const looping = noulAnswer.safeParse(answers["looping"]);
    const progress = scoreAnswer.safeParse(answers["progress"]);
    const complete = noulAnswer.safeParse(answers["complete"]);
    const tool = select(answers, "tool", state.tools, this.config);
    const skill = select(answers, "skill", state.skills, this.config);
    const model = select(answers, "model", state.models, this.config);
    const thinking = select(answers, "thinking", state.thinking, this.config);
    return {
      ...(tool ? { tool } : {}),
      ...(skill ? { skill } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(looping.success ? { looping: looping.data.noul >= this.config.thresholds.risk } : {}),
      ...(progress.success ? { progress: progress.data.score } : {}),
      ...(complete.success ? { complete: complete.data.noul >= this.config.thresholds.fit } : {}),
    };
  }

  async risk(
    request: string,
    tool: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<number> {
    const response = responseSchema.parse(await this.client.systemOne({
      state: {
        request: request.slice(0, this.config.limits.stateChars),
        tool,
        input: JSON.stringify(input).slice(0, this.config.limits.stateChars),
      },
      questions: {
        outsideScope: {
          type: "noul",
          instructions: "Would this tool call act outside the user's requested scope?",
        },
      },
    }, signal ? { signal } : {}));
    return noulAnswer.parse(response.answers["outsideScope"]).noul;
  }
}
