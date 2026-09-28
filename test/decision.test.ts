import { expect, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "../src/config.js";
import { JevDecider, type NextState } from "../src/decision.js";

const state: NextState = {
  request: "Inspect the source file",
  lastResults: [],
  tools: [{ name: "read", description: "Read a local file" }],
  activeTools: ["read"],
  canDiscoverTools: false,
  requirements: ["Inspect the source file"],
  requirementsTruncated: false,
  verificationResults: [],
  attempts: [],
  skills: [],
  models: [],
  thinking: [],
};

function config(): PluginConfig {
  return {
    enabled: true,
    autoUpdate: false,
    mode: "advise",
    experimentalCodeSearch: false,
    provider: { selected: "jev_compatible", jev_compatible: {}, "respan-ai": {} },
    models: [],
    activatableTools: [],
    display: { startup: true, decisions: false },
    telemetry: { detailed: true },
    decisions: {
      skills: false, nextAction: true, toolDiscovery: false, toolActivation: false,
      toolPreflight: false, resultAssessment: false, loopDetection: false,
      completion: false, modelRouting: false, thinkingLevel: false,
    },
    limits: { timeoutMs: 1000, spanTimeoutMs: 10000, maxCallsPerAgentRun: 30, stateChars: 2000 },
    thresholds: { fit: 0.6, confidence: 0.65, risk: 0.8 },
    includeToolOutput: false,
    includeToolErrors: false,
    skillRerank: false,
    redactValues: [],
    redactPatterns: [],
    preflightOnError: "allow",
  };
}

function serverFor(answer: Record<string, unknown>) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body: unknown = await req.json();
      if (!body || typeof body !== "object" || !("questions" in body)) {
        return Response.json({ error: "Missing questions" }, { status: 422 });
      }
      return Response.json({ model: "jev-1.13.0", answers: answer, usage: { input_tokens: 5, output_tokens: 2 } });
    },
  });
  const client = new TypeSafeClient({
    apiKey: "test-key",
    baseURL: `http://127.0.0.1:${server.port}`,
    retry: { maxRetries: 0 },
  });
  return { server, client };
}

test("recommends a registered tool when its absolute fit is high", async () => {
  // Given the SDK's real HTTP transport and a typed Jev answer.
  const { server, client } = serverFor({
    tool: {
      type: "choice", choice: "read", confidence: 0.9,
      probabilities: { read: 0.95, __none__: 0.05 },
    },
    toolFits: { type: "noul", noul: 0.9 },
  });
  try {
    // When Jev selects the tool.
    const result = await new JevDecider(config(), client).next(state);
    // Then the known tool is recommended.
    expect(result.tool).toBe("read");
  } finally {
    server.stop(true);
  }
});

test("sends the configured key to the configured endpoint", async () => {
  // Given a local Jev endpoint and a key supplied by the plugin config.
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push(req.headers.get("authorization") ?? "");
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          tool: {
            type: "choice", choice: "read", confidence: 0.9,
            probabilities: { read: 0.95, __none__: 0.05 },
          },
          toolFits: { type: "noul", noul: 0.9 },
        },
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    },
  });
  const configured = config();
  configured.provider.jev_compatible.apiKey = "configured-key";
  configured.provider.jev_compatible.endpoint = `http://127.0.0.1:${server.port}`;
  try {
    // When the production client makes a decision.
    const result = await new JevDecider(configured).next(state);
    // Then the request reached that endpoint with the configured key.
    expect(result.tool).toBe("read");
    expect(received).toEqual(["Bearer configured-key"]);
  } finally {
    server.stop(true);
  }
});

for (const model of ["respan/span-01", "respan/span-01-lite"]) {
  test(`routes ${model} through OpenRouter decisions with the configured key`, async () => {
    // Given a local OpenRouter-compatible endpoint and a typed answer.
    const requests: { path: string; key: string; body: unknown }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        if (typeof body.state !== "string" || Object.values(body.questions).some((entry) => {
          const question: unknown = entry;
          if (!question || typeof question !== "object" || !("type" in question)
            || !("instructions" in question) || question.type !== "noul"
            || typeof question.instructions !== "string") return true;
          if (!("criteria" in question) || question.criteria == null) return false;
          const criteria: unknown = question.criteria;
          return !criteria || typeof criteria !== "object" || !("true" in criteria) || !("false" in criteria)
            || typeof criteria.true !== "string" || typeof criteria.false !== "string";
        })) {
          return Response.json({ error: "Respan accepts only string state and plain-string noul questions" },
            { status: 400 });
        }
        requests.push({
          path: new URL(req.url).pathname,
          key: req.headers.get("authorization") ?? "",
          body,
        });
        const answers = Object.fromEntries(Object.keys(body.questions).map((name) => [name, {
          type: "noul",
          noul: name === "tool__0" ? 0.05 : name === "tool__1" ? 0.95
            : name === "progress__0" ? 0.2 : name === "progress__1" || name === "progress__2" ? 0.4
              : name === "outsideScope" ? 0.1 : 0.9,
        }]));
        return Response.json({
          model: `${model}-20260925`,
          answers,
          usage: { input_tokens: 51, output_tokens: 0, cost: 0 },
        });
      },
    });
    const selected = config();
    selected.provider.selected = "respan-ai";
    selected.provider.jev_compatible.apiKey = "typesafe-key";
    selected.provider["respan-ai"].model = model;
    selected.provider["respan-ai"].apiKey = "openrouter-key";
    selected.provider["respan-ai"].endpoint = `http://127.0.0.1:${server.port}`;
    selected.decisions.resultAssessment = true;
    try {
      // When the real plugin transport handles a turn and a preflight call.
      const decider = new JevDecider(selected);
      const result = await decider.next({ ...state, lastResults: ["read: success"] });
      const risk = await decider.risk("Inspect source", "read", { path: "a.ts" });
      // Then both requests reach the Decisions endpoint and preserve the selected model.
      expect(result.tool).toBe("read");
      expect(result.progress).toBeCloseTo(1.2);
      expect(risk).toBe(0.1);
      expect(requests).toHaveLength(2);
      expect(requests.map(({ path }) => path)).toEqual(["/api/alpha/decisions", "/api/alpha/decisions"]);
      expect(requests.map(({ key }) => key)).toEqual(["Bearer openrouter-key", "Bearer openrouter-key"]);
      expect(requests.map(({ body }) => body && typeof body === "object" && "model" in body
        ? body.model : undefined)).toEqual([model, model]);
      expect(requests[0]?.body).toMatchObject({
        state: JSON.stringify({ request: state.request, lastResults: ["read: success"] }),
      });
      expect(requests[0]?.body).toMatchObject({
        questions: {
          tool__0: { type: "noul" },
          tool__1: { type: "noul" },
          progress__0: { type: "noul" },
          progress__1: { type: "noul" },
          progress__2: { type: "noul" },
          toolFits: { type: "noul" },
        },
      });
    } finally {
      server.stop(true);
    }
  });
}

test("routes a custom Respan model ID by provider rather than its name", async () => {
  // Given an ID without the respan/ prefix, served through the Respan provider.
  const requests: Array<{ path: string; model: string; type: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      requests.push({
        path: new URL(req.url).pathname, model: body.model, type: body.questions.outsideScope.type,
      });
      return Response.json({
        model: body.model, answers: { outsideScope: { type: "noul", noul: 0.2 } },
        usage: { input_tokens: 5, output_tokens: 0 },
      });
    },
  });
  const selected = config();
  selected.provider.selected = "respan-ai";
  selected.provider["respan-ai"].model = "custom/respan-scorer";
  selected.provider["respan-ai"].apiKey = "openrouter-key";
  selected.provider["respan-ai"].endpoint = `http://127.0.0.1:${server.port}`;
  try {
    // When a preflight question is scored.
    const risk = await new JevDecider(selected).risk("Inspect", "read", { path: "src/config.ts" });
    // Then the provider controls transport while the model ID is sent unchanged.
    expect(risk).toBe(0.2);
    expect(requests).toEqual([{
      path: "/api/alpha/decisions", model: "custom/respan-scorer", type: "noul",
    }]);
  } finally {
    server.stop(true);
  }
});

test("does not turn an OpenRouter refusal into a tool recommendation", async () => {
  // Given a Decisions endpoint rejecting a request.
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ error: { message: "Rate limit exceeded" } }, { status: 429 }),
  });
  const selected = config();
  selected.provider.selected = "respan-ai";
  selected.provider["respan-ai"].apiKey = "openrouter-key";
  selected.provider["respan-ai"].endpoint = `http://127.0.0.1:${server.port}`;
  try {
    // When a turn asks the selected model for a decision.
    const result = new JevDecider(selected).next(state);
    // Then the request fails explicitly instead of returning a fabricated decision.
    await expect(result).rejects.toMatchObject({ status: 429 });
  } finally {
    server.stop(true);
  }
});

test("does not recommend a Span choice below the confidence threshold", async () => {
  // Given independently scored candidates with a weak winning probability.
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      return Response.json({
        model: "respan/span-01-lite-20260925",
        answers: Object.fromEntries(Object.keys(body.questions).map((name) => [name, {
          type: "noul", noul: name === "tool__0" ? 0.45 : name === "tool__1" ? 0.55 : 0.9,
        }])),
        usage: { input_tokens: 20, output_tokens: 0 },
      });
    },
  });
  const selected = config();
  selected.provider.selected = "respan-ai";
  selected.provider["respan-ai"].apiKey = "openrouter-key";
  selected.provider["respan-ai"].endpoint = `http://127.0.0.1:${server.port}`;
  try {
    // When the choice is evaluated through the Decisions endpoint.
    const result = await new JevDecider(selected).next(state);
    // Then the local confidence threshold still prevents the recommendation.
    expect(result.tool).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("does not recommend a forced Choice winner when nothing fits", async () => {
  // Given a confident winner but a low absolute fit.
  const { server, client } = serverFor({
    tool: {
      type: "choice", choice: "read", confidence: 0.9,
      probabilities: { read: 0.95, __none__: 0.05 },
    },
    toolFits: { type: "noul", noul: 0.1 },
  });
  try {
    // When the decision is evaluated.
    const result = await new JevDecider(config(), client).next(state);
    // Then it abstains.
    expect(result.tool).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("requests tool discovery separately when available tools do not fit", async () => {
  // Given an active search tool and a Jev answer that declines all ordinary tools.
  const active = config();
  active.decisions.toolDiscovery = true;
  const questions: string[][] = [];
  const availableTools: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      questions.push(Object.keys(body.questions));
      availableTools.push(body.state.availableTools);
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          tool: { type: "choice", choice: "__none__", confidence: 0.9,
            probabilities: { read: 0.1, __none__: 0.9 } },
          toolFits: { type: "noul", noul: 0.1 },
          discoverTools: { type: "noul", noul: 0.95 },
        },
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    },
  });
  const client = new TypeSafeClient({
    apiKey: "test-key", baseURL: `http://127.0.0.1:${server.port}`, retry: { maxRetries: 0 },
  });
  try {
    // When separate action and discovery judgments are requested.
    const result = await new JevDecider(active, client).next({
      ...state, canDiscoverTools: true,
      tools: [...state.tools, { name: "tool_search", description: "Discover more tools" }],
    });
    // Then search is suggested without being selected as an ordinary tool.
    expect(result.tool).toBeUndefined();
    expect(result.discoverTools).toBe(true);
    expect(questions).toEqual([["tool", "toolFits", "discoverTools"]]);
    expect(availableTools).toEqual([["read"]]);
  } finally {
    server.stop(true);
  }
});

test("does not recommend discovery when an available tool is selected", async () => {
  // Given high scores for both a registered tool and the discovery question.
  const active = config();
  active.decisions.toolDiscovery = true;
  const { server, client } = serverFor({
    tool: { type: "choice", choice: "read", confidence: 0.9, probabilities: { read: 0.9, __none__: 0.1 } },
    toolFits: { type: "noul", noul: 0.9 },
    discoverTools: { type: "noul", noul: 0.95 },
  });
  try {
    // When Jev evaluates the same turn.
    const result = await new JevDecider(active, client).next({ ...state, canDiscoverTools: true });
    // Then the valid active action wins instead of a search suggestion.
    expect(result.tool).toBe("read");
    expect(result.discoverTools).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("does not request discovery when tool_search is inactive", async () => {
  // Given discovery enabled but no active search tool or other judgments.
  const active = config();
  active.decisions.nextAction = false;
  active.decisions.toolDiscovery = true;
  const { server, client } = serverFor({ discoverTools: { type: "noul", noul: 1 } });
  try {
    // When Jev is asked for a next decision.
    const result = await new JevDecider(active, client).next(state);
    // Then no impossible search action is suggested.
    expect(result).toEqual({});
  } finally {
    server.stop(true);
  }
});

test("rejects invented check references in completion evidence", async () => {
  // Given one recorded test result and an answer citing a nonexistent result for one requirement.
  const active = config();
  active.decisions.nextAction = false;
  active.decisions.completion = true;
  const { server, client } = serverFor({
    complete: { type: "noul", noul: 0.99 },
    verify0: { type: "choice", choice: "imaginary", confidence: 0.99,
      probabilities: { imaginary: 0.99, "check-tests": 0.01 } },
    verify0Fits: { type: "noul", noul: 0.99 },
    verify1: { type: "choice", choice: "check-tests", confidence: 0.99,
      probabilities: { "check-tests": 0.99, __none__: 0.01 } },
    verify1Fits: { type: "noul", noul: 0.99 },
  });
  try {
    // When Jev evaluates the available check against both requirements.
    const result = await new JevDecider(active, client).next({
      ...state, requirements: ["Run tests", "Inspect the output"],
      verificationResults: [{ id: "check-tests", tool: "bash", kind: "test" }],
    });
    // Then only the real result can be mapped and completion remains unsupported.
    expect(result.complete).toBe(true);
    expect(result.completionEvidence).toBe(false);
    expect(result.verifiedRequirements).toEqual([
      { requirementIndex: 1, result: { id: "check-tests", tool: "bash", kind: "test" } },
    ]);
  } finally {
    server.stop(true);
  }
});

test("selects only an untried active tool for recovery", async () => {
  // Given one failed attempt, one active alternative, and an inactive suggestion.
  const active = config();
  active.decisions.nextAction = false;
  active.decisions.resultAssessment = true;
  const attempted = {
    ...state, lastResults: ["read: error"], attempts: [{ tool: "read", failed: true, failure: "missing-path" }] as const,
    tools: [...state.tools, { name: "grep", description: "Search files" }, { name: "bash", description: "Run shell" }],
    activeTools: ["read", "grep"],
  };
  const { server, client } = serverFor({
    recoveryTool: { type: "choice", choice: "grep", confidence: 0.9,
      probabilities: { grep: 0.9, __none__: 0.1 } },
    recoveryToolFits: { type: "noul", noul: 0.9 },
    progress: { type: "score", score: 0.1 },
  });
  try {
    // When the recovery candidate is evaluated.
    const result = await new JevDecider(active, client).next(attempted);
    // Then the locally available untried tool may be proposed.
    expect(result.recoveryTool).toBe("grep");
  } finally {
    server.stop(true);
  }
});

test("ignores an inactive Jev recovery tool", async () => {
  // Given an otherwise plausible tool outside the active host set.
  const active = config();
  active.decisions.nextAction = false;
  active.decisions.resultAssessment = true;
  const { server, client } = serverFor({
    recoveryTool: { type: "choice", choice: "bash", confidence: 0.99,
      probabilities: { bash: 0.99, grep: 0.01 } },
    recoveryToolFits: { type: "noul", noul: 0.99 },
    progress: { type: "score", score: 0.1 },
  });
  try {
    // When Jev names a tool the host has not activated.
    const result = await new JevDecider(active, client).next({
      ...state, lastResults: ["read: error"], attempts: [{ tool: "read", failed: true }],
      tools: [...state.tools, { name: "grep", description: "Search files" }, { name: "bash", description: "Run shell" }],
      activeTools: ["read", "grep"],
    });
    // Then the recommendation is not passed to the agent.
    expect(result.recoveryTool).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("does not pass an unknown tool from a malformed response", async () => {
  // Given a tool not present in the local registry.
  const { server, client } = serverFor({
    tool: {
      type: "choice", choice: "remove_all", confidence: 1,
      probabilities: { remove_all: 1, __none__: 0 },
    },
    toolFits: { type: "noul", noul: 1 },
  });
  try {
    // When the decision is evaluated.
    const result = await new JevDecider(config(), client).next(state);
    // Then the unknown ID is rejected.
    expect(result.tool).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("rejects a malformed preflight answer rather than granting a verdict", async () => {
  // Given an incomplete response to a preflight question.
  const { server, client } = serverFor({ outsideScope: { type: "noul" } });
  try {
    // When the preflight decision is parsed.
    const result = new JevDecider(config(), client).risk("Read the file", "read", { path: "a.ts" });
    // Then no risk score is manufactured.
    await expect(result).rejects.toThrow();
  } finally {
    server.stop(true);
  }
});

test("reports usage from a successful Jev decision response", async () => {
  // Given a real SDK request and a valid response with usage metadata.
  const { server, client } = serverFor({
    tool: { type: "choice", choice: "read", confidence: 0.9, probabilities: { read: 0.9, __none__: 0.1 } },
    toolFits: { type: "noul", noul: 0.9 },
  });
  const recorded: { input: number; output: number; model: string }[] = [];
  try {
    // When the decision completes.
    await new JevDecider(config(), client, (usage, model) => {
      recorded.push({ input: usage.input_tokens, output: usage.output_tokens, model });
    }).next(state);
    // Then the usage is attributed to the responding model once.
    expect(recorded).toEqual([{ input: 5, output: 2, model: "jev-1.13.0" }]);
  } finally {
    server.stop(true);
  }
});

test("reports usage from a preflight response even if its answer is malformed", async () => {
  // Given a response that consumed tokens but lacks a valid risk answer.
  const { server, client } = serverFor({ outsideScope: { type: "noul" } });
  const recorded: number[] = [];
  try {
    // When the preflight parser rejects the answer.
    await expect(new JevDecider(config(), client, (usage) => {
      recorded.push(usage.input_tokens);
    }).risk("Read", "read", { path: "a.ts" })).rejects.toThrow();
    // Then the completed request's token usage is still counted.
    expect(recorded).toEqual([5]);
  } finally {
    server.stop(true);
  }
});

test("keeps loop and progress judgments separate from action selection", async () => {
  // Given a recent failed step and independent typed judgments.
  const active = config();
  active.decisions.loopDetection = true;
  active.decisions.resultAssessment = true;
  const { server, client } = serverFor({
    tool: { type: "choice", choice: "__none__", confidence: 0.8, probabilities: { read: 0.1, __none__: 0.9 } },
    toolFits: { type: "noul", noul: 0.2 },
    looping: { type: "noul", noul: 0.99 },
    progress: { type: "score", score: 0.2 },
  });
  try {
    // When recent results are evaluated.
    const result = await new JevDecider(active, client).next({ ...state, lastResults: ["read: error"] });
    // Then loop detection does not force a tool recommendation.
    expect(result.looping).toBe(true);
    expect(result.progress).toBe(0.2);
    expect(result.tool).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("reranks a large skill roster with bounded local skill details", async () => {
  // Given ambiguous short descriptions and a detailed local skill file.
  const dir = await mkdtemp(join(tmpdir(), "omo-jev-skills-"));
  const filePath = join(dir, "SKILL.md");
  const requests: unknown[] = [];
  let counted = 0;
  const active = config();
  active.decisions.skills = true;
  active.decisions.nextAction = false;
  active.skillRerank = true;
  active.redactValues = ["SECRET456"];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body: unknown = await req.json();
      requests.push(body);
      const first = requests.length === 1;
      return Response.json({
        model: "jev-1.13.0",
        answers: first ? {
          skill: {
            type: "choice", choice: "skill-0", confidence: 0.9,
            probabilities: { "skill-0": 0.8, "skill-1": 0.15, "skill-2": 0.05 },
          },
          skillFits: { type: "noul", noul: 0.9 },
        } : {
          skill: {
            type: "choice", choice: "skill-1", confidence: 0.9,
            probabilities: { "skill-0": 0.1, "skill-1": 0.9, "skill-2": 0 },
          },
          skillFits: { type: "noul", noul: 0.9 },
        },
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    },
  });
  try {
    const detail = "The skill-1 details explain its precise use case.";
    await writeFile(filePath, `${detail}${"x".repeat(500 - detail.length - 3)}SECRET456`);
    const client = new TypeSafeClient({
      apiKey: "test-key", baseURL: `http://127.0.0.1:${server.port}`, retry: { maxRetries: 0 },
    });
    const skills = Array.from({ length: 25 }, (_, index) => ({
      name: `skill-${index}`, description: "Similar brief description", filePath,
    }));

    // When a large roster is evaluated with room in the request budget.
    const result = await new JevDecider(active, client, undefined, () => { counted++; })
      .next({ ...state, skills }, undefined, 3);

    // Then the shortlist is reconsidered with detail, without transmitting the local path.
    expect(result.skill).toBe("skill-1");
    expect(requests).toHaveLength(2);
    expect(counted).toBe(2);
    expect(JSON.stringify(requests[1])).toContain("precise use case");
    expect(JSON.stringify(requests[1])).not.toContain("SEC");
    expect(JSON.stringify(requests)).not.toContain(dir);
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("reserves the last Jev call instead of reranking skills", async () => {
  // Given a large roster with only two calls remaining.
  const active = config();
  active.decisions.nextAction = false;
  active.decisions.skills = true;
  active.skillRerank = true;
  const { server, client } = serverFor({
    skill: { type: "choice", choice: "skill-0", confidence: 0.9,
      probabilities: { "skill-0": 0.9, __none__: 0.1 } },
    skillFits: { type: "noul", noul: 0.9 },
  });
  let calls = 0;
  try {
    // When the skill decision is made with a final call reserved.
    const result = await new JevDecider(active, client, undefined, () => { calls++; }).next({
      ...state, skills: Array.from({ length: 25 }, (_, index) => ({
        name: `skill-${index}`, description: "Candidate skill",
      })),
    }, undefined, 2);
    // Then the primary recommendation is retained without an extra rerank request.
    expect(result.skill).toBe("skill-0");
    expect(calls).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("spends the last call on mapped completion evidence before other judgments", async () => {
  // Given an observed check alongside available tools, skills, and recent progress.
  const active = config();
  active.decisions.completion = true;
  active.decisions.resultAssessment = true;
  active.decisions.skills = true;
  const asked: string[][] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      asked.push(Object.keys(body.questions));
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          complete: { type: "noul", noul: 0.9 },
          verify0: { type: "choice", choice: "check-1", confidence: 0.9,
            probabilities: { "check-1": 0.9, __none__: 0.1 } },
          verify0Fits: { type: "noul", noul: 0.9 },
          tool: { type: "choice", choice: "read", confidence: 0.9,
            probabilities: { read: 0.9, __none__: 0.1 } },
          toolFits: { type: "noul", noul: 0.9 },
        },
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    },
  });
  const client = new TypeSafeClient({
    apiKey: "test-key", baseURL: `http://127.0.0.1:${server.port}`, retry: { maxRetries: 0 },
  });
  try {
    // When the final available call is made.
    const result = await new JevDecider(active, client).next({
      ...state, lastResults: ["bash: success"],
      skills: [{ name: "inspect", description: "Inspect code" }],
      verificationResults: [{ id: "check-1", tool: "bash", kind: "test" }],
    }, undefined, 1);
    // Then only completion and direct-evidence mapping were requested or accepted.
    expect(asked).toEqual([["complete", "verify0", "verify0Fits"]]);
    expect(result.completionEvidence).toBe(true);
    expect(result.tool).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("prioritizes failure recovery over completion when one call remains", async () => {
  // Given a fresh failed result, an older successful check, and an untried active tool.
  const active = config();
  active.decisions.completion = true;
  active.decisions.resultAssessment = true;
  active.decisions.loopDetection = true;
  const asked: string[][] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      asked.push(Object.keys(body.questions));
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          progress: { type: "score", score: 0.2 },
          looping: { type: "noul", noul: 0.9 },
          recoveryTool: { type: "choice", choice: "grep", confidence: 0.9,
            probabilities: { grep: 0.9, __none__: 0.1 } },
          recoveryToolFits: { type: "noul", noul: 0.9 },
          complete: { type: "noul", noul: 0.99 },
        },
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    },
  });
  const client = new TypeSafeClient({
    apiKey: "test-key", baseURL: `http://127.0.0.1:${server.port}`, retry: { maxRetries: 0 },
  });
  try {
    // When the last call responds with both asked and unsolicited fields.
    const result = await new JevDecider(active, client).next({
      ...state, lastResults: ["read: error"],
      attempts: [{ tool: "read", failed: true, failure: "missing-path" }],
      verificationResults: [{ id: "check-1", tool: "bash", kind: "test" }],
      tools: [...state.tools, { name: "grep", description: "Search code" }],
      activeTools: ["read", "grep"],
    }, undefined, 1);
    // Then recovery is preserved while an unasked completion claim is ignored.
    expect(asked).toEqual([["recoveryTool", "recoveryToolFits", "looping", "progress"]]);
    expect(result.recoveryTool).toBe("grep");
    expect(result.complete).toBeUndefined();
    expect(result.completionEvidence).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("does not spend the last call on completion without a direct check", async () => {
  // Given a completion-only configuration after a non-verifying read result.
  const active = config();
  active.decisions.nextAction = false;
  active.decisions.completion = true;
  let calls = 0;
  const { server, client } = serverFor({ complete: { type: "noul", noul: 0.9 } });
  try {
    // When a turn starts with one call remaining but no direct check.
    const result = await new JevDecider(active, client, undefined, () => { calls++; })
      .next({ ...state, lastResults: ["read: success"], attempts: [{ tool: "read", failed: false }] }, undefined, 1);
    // Then the final request remains available for later evidence.
    expect(result).toEqual({});
    expect(calls).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("masks configured exact values and patterns before Jev transport", async () => {
  // Given sensitive data in request, recent results, candidate descriptions, and preflight input.
  const sent: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      sent.push(await req.text());
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          tool: { type: "choice", choice: "read", confidence: 0.9, probabilities: { read: 0.9, __none__: 0.1 } },
          toolFits: { type: "noul", noul: 0.9 },
          outsideScope: { type: "noul", noul: 0.1 },
        },
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    },
  });
  const active = config();
  active.redactValues = ["SECRET456", 'quote"value'];
  active.redactPatterns = ["account-[0-9]+"];
  const client = new TypeSafeClient({
    apiKey: "test-key", baseURL: `http://127.0.0.1:${server.port}`, retry: { maxRetries: 0 },
  });
  try {
    // When both turn and preflight judgments reach the real SDK transport.
    const decider = new JevDecider(active, client);
    await decider.next({
      ...state,
      request: "Inspect SECRET456 for account-5432",
      lastResults: ["read: error SECRET456"],
      tools: [{ name: "read", description: "Inspect account-5432" }],
    });
    await decider.risk("Inspect SECRET456", "read", {
      path: "account-5432", value: 'quote"value', SECRET456: "SECRET456",
    });

    // Then every configured value is replaced consistently in outbound data.
    expect(sent).toHaveLength(2);
    expect(sent.join(" ")).not.toContain("SECRET456");
    expect(sent.join(" ")).not.toContain("account-5432");
    expect(sent.join(" ")).not.toContain("quote");
    expect(sent[0]).toContain("__JEV_REDACTED_0__");
    expect(sent[1]).toContain("__JEV_REDACTED_0__");
  } finally {
    server.stop(true);
  }
});

test("maps a masked candidate identifier back to its local tool", async () => {
  // Given a tool name that contains a configured value to redact.
  const { server, client } = serverFor({
    tool: {
      type: "choice", choice: "__JEV_REDACTED_0__-tool", confidence: 0.9,
      probabilities: { "__JEV_REDACTED_0__-tool": 0.9, __none__: 0.1 },
    },
    toolFits: { type: "noul", noul: 0.9 },
  });
  const active = config();
  active.redactValues = ["SECRET456"];
  try {
    // When Jev selects the masked identifier.
    const result = await new JevDecider(active, client).next({
      ...state, tools: [{ name: "SECRET456-tool", description: "Sensitive tool" }],
    });
    // Then only the known local identifier is suggested.
    expect(result.tool).toBe("SECRET456-tool");
  } finally {
    server.stop(true);
  }
});
