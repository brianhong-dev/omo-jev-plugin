import { expect, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { PluginConfig } from "../src/config.js";
import { JevDecider, type NextState } from "../src/decision.js";

const state: NextState = {
  request: "Inspect the source file",
  lastResults: [],
  tools: [{ name: "read", description: "Read a local file" }],
  skills: [],
  models: [],
  thinking: [],
};

function config(): PluginConfig {
  return {
    enabled: true,
    mode: "advise",
    model: "jev-1.13.0",
    models: [],
    activatableTools: [],
    display: { startup: true, decisions: false },
    decisions: {
      skills: false, nextAction: true, toolDiscovery: false, toolActivation: false,
      toolPreflight: false, resultAssessment: false, loopDetection: false,
      completion: false, modelRouting: false, thinkingLevel: false,
    },
    limits: { timeoutMs: 1000, maxCallsPerAgentRun: 30, stateChars: 2000 },
    thresholds: { fit: 0.6, confidence: 0.65, risk: 0.8 },
    includeToolOutput: false,
    includeToolErrors: false,
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
  configured.apiKey = "configured-key";
  configured.endpoint = `http://127.0.0.1:${server.port}`;
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
