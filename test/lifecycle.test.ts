import { expect, test } from "bun:test";
import { createEventBus, createExtensionRuntime } from "@code-yeongyu/senpi";
import { loadExtensionFromFactory } from "../node_modules/@code-yeongyu/senpi/dist/core/extensions/loader.js";
import { getThemeByName } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/theme/theme.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import jevPlugin from "../src/index.js";
import { installedVersion } from "../src/update.js";
import { usageEntrySchema } from "../src/usage.js";

test("records an update card instead of a replaceable status or persistent widget", async () => {
  const current = await installedVersion();
  const latest = current.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  const originalFetch = globalThis.fetch;
  const entries: Array<{ type: string; data: unknown }> = [];
  const notices: string[] = [];
  const widgets: string[] = [];
  const renderers = new Map<string, (entry: { data: unknown }) => unknown>();
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => url === "https://registry.npmjs.org/omo-jev-plugin/latest"
      ? Response.json({ version: latest })
      : originalFetch(url, init),
    { preconnect: originalFetch.preconnect },
  );
  try {
    const handlers = new Map<string, (event: object, ctx: object) => Promise<void>>();
    jevPlugin({
      on: (name: string, handler: (event: object, ctx: object) => Promise<void>) => handlers.set(name, handler),
      registerEntryRenderer: (name: string, renderer: (entry: { data: unknown }) => unknown) =>
        renderers.set(name, renderer),
      appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    } as unknown as Parameters<typeof jevPlugin>[0]);
    await handlers.get("session_start")?.({ type: "session_start" }, {
      cwd: process.cwd(),
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => [] },
      ui: {
        notify: (message: string) => notices.push(message),
        setWidget: (key: string) => widgets.push(key),
      },
    });

    expect(entries).toContainEqual({
      type: "jev:update",
      data: { status: "update", current, available: latest },
    });
    const rendered = Reflect.apply(renderers.get("jev:update")!, undefined, [
      { data: { status: "update", current, available: latest } }, { expanded: false }, getThemeByName("dark"),
    ]) as { render(width: number): string[] };
    expect(rendered.render(100).join(" ")).toContain(`omo-jev-plugin ${latest} is available`);
    expect(rendered.render(100).join(" ")).toContain(`Installed: ${current}. Run omo update npm:omo-jev-plugin to update.`);
    expect(notices.some((message) => message.includes(`${latest} is available`))).toBe(false);
    expect(widgets).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("records a current-version card when the registry matches the installed version", async () => {
  const current = await installedVersion();
  const originalFetch = globalThis.fetch;
  const entries: Array<{ type: string; data: unknown }> = [];
  const renderers = new Map<string, (entry: { data: unknown }) => unknown>();
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => url === "https://registry.npmjs.org/omo-jev-plugin/latest"
      ? Response.json({ version: current })
      : originalFetch(url, init),
    { preconnect: originalFetch.preconnect },
  );
  try {
    const handlers = new Map<string, (event: object, ctx: object) => Promise<void>>();
    jevPlugin({
      on: (name: string, handler: (event: object, ctx: object) => Promise<void>) => handlers.set(name, handler),
      registerEntryRenderer: (name: string, renderer: (entry: { data: unknown }) => unknown) =>
        renderers.set(name, renderer),
      appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    } as unknown as Parameters<typeof jevPlugin>[0]);
    await handlers.get("session_start")?.({ type: "session_start" }, {
      cwd: process.cwd(),
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => [] },
      ui: { notify: () => {} },
    });
    expect(entries).toContainEqual({ type: "jev:update", data: { status: "current", current } });
    const rendered = Reflect.apply(renderers.get("jev:update")!, undefined, [
      { data: { status: "current", current } }, { expanded: false }, getThemeByName("dark"),
    ]) as { render(width: number): string[] };
    expect(rendered.render(100).join(" ")).toContain(`omo-jev-plugin ${current} is up to date`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("records per-turn and session Jev usage in the UI history without a startup widget", async () => {
  // Given the host extension loader, two Jev responses, and a trusted local configuration.
  const cwd = await mkdtemp(join(tmpdir(), "omo-jev-lifecycle-"));
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        model: "jev-1.13.0",
        answers: { complete: { type: "noul", noul: 0.2 } },
        usage: { input_tokens: 11, output_tokens: 2 },
      });
    },
  });
  try {
    await mkdir(join(cwd, ".omo"));
    await writeFile(join(cwd, ".omo", "jev-plugin.jsonc"), JSON.stringify({
      enabled: true,
      mode: "shadow",
      apiKey: "local-test-key",
      endpoint: `http://127.0.0.1:${server.port}`,
      display: { startup: true, decisions: false },
      decisions: {
        skills: false, nextAction: false, toolDiscovery: false, toolActivation: false,
        toolPreflight: false, resultAssessment: false, loopDetection: false,
        completion: true, modelRouting: false, thinkingLevel: false,
      },
    }));
    const runtime = createExtensionRuntime();
    const history: { type: string; data: unknown }[] = [];
    runtime.appendEntry = (type, data) => { history.push({ type, data }); };
    runtime.getActiveTools = () => [];
    runtime.getAllTools = () => [];
    const extension = await loadExtensionFromFactory(jevPlugin, cwd, createEventBus(), runtime);
    const notices: string[] = [];
    const widgets: string[] = [];
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      sessionManager: { getBranch: () => history.filter((entry) => entry.type === "jev:usage")
        .map((entry) => ({ type: "custom", customType: entry.type, data: entry.data })) },
      ui: {
        notify: (message: string) => { notices.push(message); },
        setWidget: (key: string) => { widgets.push(key); },
      },
      modelRegistry: { getAvailable: () => [] },
      signal: undefined,
    };
    const emit = async (name: string, event: object) => {
      for (const handler of extension.handlers.get(name) ?? []) await Reflect.apply(handler, undefined, [event, ctx]);
    };

    // When the host completes two turns, with one Jev request per turn.
    await emit("session_start", { type: "session_start" });
    await emit("before_agent_start", {
      type: "before_agent_start", prompt: "Inspect", systemPromptOptions: { skills: [] },
    });
    await emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
    await emit("turn_end", { type: "turn_end", turnIndex: 0 });
    await emit("tool_result", { type: "tool_result", toolName: "read", isError: false, content: [] });
    await emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
    await emit("turn_end", { type: "turn_end", turnIndex: 1 });

    // Then the host receives display-only records with separate turn and session totals.
    const records = history.filter((entry) => entry.type === "jev:usage").map((entry) => usageEntrySchema.parse(entry.data));
    expect(records.map(({ turn, session }) => [turn.inputTokens, session.inputTokens])).toEqual([[11, 11], [11, 22]]);
    expect(records[1]?.session.estimatedCost).toBe(22 * 0.042 / 1_000_000);
    expect(notices.filter((message) => message.startsWith("Jev active:"))).toHaveLength(1);
    expect(widgets).toEqual([]);
    const theme = getThemeByName("dark");
    const renderer = extension.entryRenderers?.get("jev:usage");
    expect(renderer).toBeDefined();
    expect(theme).toBeDefined();
    if (renderer && theme) {
      const rendered = Reflect.apply(renderer, undefined, [
        { type: "custom", customType: "jev:usage", data: records[1] }, { expanded: false }, theme,
      ]);
      expect(rendered).toHaveProperty("render");
      if (rendered && typeof rendered === "object" && "render" in rendered && typeof rendered.render === "function") {
        const lines = rendered.render(100).join(" ");
        expect(lines).toContain("Session:");
        expect(lines).toContain("Turn:");
      }
    }
  } finally {
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sends bounded failed-tool evidence while keeping successful output private", async () => {
  // Given a local Jev endpoint and explicit permission to include failed tool output.
  const cwd = await mkdtemp(join(tmpdir(), "omo-jev-errors-"));
  const states: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body: unknown = await request.json();
      if (body && typeof body === "object" && "state" in body) states.push(body.state);
      return Response.json({
        model: "jev-1.13.0",
        answers: { complete: { type: "noul", noul: 0.1 } },
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    },
  });
  try {
    await mkdir(join(cwd, ".omo"));
    await writeFile(join(cwd, ".omo", "jev-plugin.jsonc"), JSON.stringify({
      mode: "shadow", apiKey: "test-key", endpoint: `http://127.0.0.1:${server.port}`,
      includeToolErrors: true, limits: { stateChars: 100 }, redactValues: ["SECRET456"],
      decisions: {
        skills: false, nextAction: false, toolDiscovery: false, toolActivation: false,
        toolPreflight: false, resultAssessment: false, loopDetection: false,
        completion: true, modelRouting: false, thinkingLevel: false,
      },
    }));
    const runtime = createExtensionRuntime();
    runtime.appendEntry = () => {};
    runtime.getActiveTools = () => [];
    runtime.getAllTools = () => [];
    const extension = await loadExtensionFromFactory(jevPlugin, cwd, createEventBus(), runtime);
    const ctx = {
      cwd, isProjectTrusted: () => true,
      sessionManager: { getBranch: () => [] },
      ui: { notify: () => {} },
      modelRegistry: { getAvailable: () => [] },
      signal: undefined,
    };
    const emit = async (name: string, event: object) => {
      for (const handler of extension.handlers.get(name) ?? []) await Reflect.apply(handler, undefined, [event, ctx]);
    };

    // When success and failure results arrive before the next decision.
    await emit("session_start", { type: "session_start" });
    await emit("before_agent_start", {
      type: "before_agent_start", prompt: "Inspect", systemPromptOptions: { skills: [] },
    });
    await emit("tool_result", {
      type: "tool_result", toolName: "read", isError: false,
      content: [{ type: "text", text: "private successful content" }],
    });
    await emit("tool_result", {
      type: "tool_result", toolName: "bash", isError: true,
      content: [{ type: "text", text: `ENOENT: missing file ${"x".repeat(75)}SECRET456${"x".repeat(125)}` }],
    });
    await emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });

    // Then only the bounded diagnostic excerpt reaches Jev.
    expect(states).toHaveLength(1);
    const sent = JSON.stringify(states[0]);
    expect(sent).toContain("ENOENT: missing file");
    expect(sent).not.toContain("private successful content");
    expect(sent).not.toContain("SECR");
    expect(sent).not.toContain("x".repeat(100));
  } finally {
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("records shadow recommendations against executed tool results", async () => {
  // Given a shadow decision recommending a known tool.
  const cwd = await mkdtemp(join(tmpdir(), "omo-jev-shadow-"));
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          tool: { type: "choice", choice: "read", confidence: 0.9, probabilities: { read: 0.9, __none__: 0.1 } },
          toolFits: { type: "noul", noul: 0.9 },
        },
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    },
  });
  try {
    await mkdir(join(cwd, ".omo"));
    await writeFile(join(cwd, ".omo", "jev-plugin.jsonc"), JSON.stringify({
      mode: "shadow", apiKey: "test-key", endpoint: `http://127.0.0.1:${server.port}`,
      decisions: {
        skills: false, nextAction: true, toolDiscovery: false, toolActivation: false,
        toolPreflight: false, resultAssessment: false, loopDetection: false,
        completion: false, modelRouting: false, thinkingLevel: false,
      },
    }));
    const runtime = createExtensionRuntime();
    const history: Array<{ type: string; data: unknown }> = [];
    runtime.appendEntry = (type, data) => { history.push({ type, data }); };
    runtime.getActiveTools = () => ["read", "bash"];
    runtime.getAllTools = () => [
      {
        name: "read", label: "Read", description: "Read a file", parameters: Type.Object({}),
        sourceInfo: { path: "test", source: "test", scope: "system", origin: "top-level" },
        exposure: "direct", searchKeywords: [], allowLazyActivation: false,
      },
      {
        name: "bash", label: "Bash", description: "Run a command", parameters: Type.Object({}),
        sourceInfo: { path: "test", source: "test", scope: "system", origin: "top-level" },
        exposure: "direct", searchKeywords: [], allowLazyActivation: false,
      },
    ];
    const extension = await loadExtensionFromFactory(jevPlugin, cwd, createEventBus(), runtime);
    const ctx = {
      cwd, isProjectTrusted: () => true,
      sessionManager: { getBranch: () => [] },
      ui: { notify: () => {} },
      modelRegistry: { getAvailable: () => [] },
      signal: undefined,
    };
    const emit = async (name: string, event: object) => {
      for (const handler of extension.handlers.get(name) ?? []) await Reflect.apply(handler, undefined, [event, ctx]);
    };

    // When the first turn uses the recommendation but fails, and the second uses another tool.
    await emit("session_start", { type: "session_start" });
    await emit("before_agent_start", {
      type: "before_agent_start", prompt: "Inspect", systemPromptOptions: { skills: [] },
    });
    await emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
    await emit("tool_result", { type: "tool_result", toolName: "read", isError: true, content: [] });
    await emit("turn_end", { type: "turn_end", turnIndex: 0 });
    await emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
    await emit("tool_result", { type: "tool_result", toolName: "bash", isError: false, content: [] });
    await emit("turn_end", { type: "turn_end", turnIndex: 1 });

    // Then observations distinguish following a recommendation from its outcome.
    expect(history.filter(({ type }) => type === "jev:feedback").map(({ data }) => data)).toEqual([
      { turnIndex: 0, recommended: "read", followed: true, succeeded: false },
      { turnIndex: 1, recommended: "read", followed: false },
    ]);
  } finally {
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("suggests reconsideration only after consecutive low-progress judgments", async () => {
  // Given a Jev result assessor that observes little progress twice, then improvement.
  const cwd = await mkdtemp(join(tmpdir(), "omo-jev-progress-"));
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return Response.json({
        model: "jev-1.13.0",
        answers: { progress: { type: "score", score: requests === 3 ? 1.2 : 0.2 } },
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    },
  });
  try {
    await mkdir(join(cwd, ".omo"));
    await writeFile(join(cwd, ".omo", "jev-plugin.jsonc"), JSON.stringify({
      mode: "advise", apiKey: "test-key", endpoint: `http://127.0.0.1:${server.port}`,
      decisions: {
        skills: false, nextAction: false, toolDiscovery: false, toolActivation: false,
        toolPreflight: false, resultAssessment: true, loopDetection: false,
        completion: false, modelRouting: false, thinkingLevel: false,
      },
    }));
    const runtime = createExtensionRuntime();
    runtime.appendEntry = () => {};
    runtime.getActiveTools = () => [];
    runtime.getAllTools = () => [];
    const extension = await loadExtensionFromFactory(jevPlugin, cwd, createEventBus(), runtime);
    const ctx = {
      cwd, isProjectTrusted: () => true,
      sessionManager: { getBranch: () => [] },
      ui: { notify: () => {} },
      modelRegistry: { getAvailable: () => [] },
      signal: undefined,
    };
    const emit = async (name: string, event: object) => {
      let result: unknown;
      for (const handler of extension.handlers.get(name) ?? []) {
        result = await Reflect.apply(handler, undefined, [event, ctx]);
      }
      return result;
    };

    // When each new tool result drives another judgment.
    await emit("session_start", { type: "session_start" });
    await emit("before_agent_start", {
      type: "before_agent_start", prompt: "Inspect", systemPromptOptions: { skills: [] },
    });
    const advice: string[] = [];
    for (let turnIndex = 0; turnIndex < 4; turnIndex++) {
      await emit("tool_result", { type: "tool_result", toolName: "read", isError: false, content: [] });
      await emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex });
      advice.push(JSON.stringify(await emit("context", { type: "context", messages: [] })) ?? "");
    }

    // Then the second low score advises a change, improvement resets the streak.
    expect(advice[0]).not.toContain("little progress");
    expect(advice[1]).toContain("little progress");
    expect(advice[2]).not.toContain("little progress");
    expect(advice[3]).not.toContain("little progress");
  } finally {
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("qualifies completion advice with a recorded successful result", async () => {
  // Given a completion judgment before and after a successful observable check.
  const cwd = await mkdtemp(join(tmpdir(), "omo-jev-completion-"));
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      calls++;
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          complete: { type: "noul", noul: 0.99 },
          completionEvidence: { type: "noul", noul: calls === 1 ? 0.1 : 0.9 },
        },
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    },
  });
  try {
    await mkdir(join(cwd, ".omo"));
    await writeFile(join(cwd, ".omo", "jev-plugin.jsonc"), JSON.stringify({
      mode: "advise", apiKey: "test-key", endpoint: `http://127.0.0.1:${server.port}`,
      decisions: {
        skills: false, nextAction: false, toolDiscovery: false, toolActivation: false,
        toolPreflight: false, resultAssessment: false, loopDetection: false,
        completion: true, modelRouting: false, thinkingLevel: false,
      },
    }));
    const runtime = createExtensionRuntime();
    runtime.appendEntry = () => {};
    runtime.getActiveTools = () => [];
    runtime.getAllTools = () => [];
    const extension = await loadExtensionFromFactory(jevPlugin, cwd, createEventBus(), runtime);
    const ctx = {
      cwd, isProjectTrusted: () => true,
      sessionManager: { getBranch: () => [] },
      ui: { notify: () => {} },
      modelRegistry: { getAvailable: () => [] },
      signal: undefined,
    };
    const emit = async (name: string, event: object) => {
      let result: unknown;
      for (const handler of extension.handlers.get(name) ?? []) {
        result = await Reflect.apply(handler, undefined, [event, ctx]);
      }
      return result;
    };

    // When Jev first claims completion with no check, then judges a successful result.
    await emit("session_start", { type: "session_start" });
    await emit("before_agent_start", {
      type: "before_agent_start", prompt: "Inspect", systemPromptOptions: { skills: [] },
    });
    await emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
    const before = JSON.stringify(await emit("context", { type: "context", messages: [] })) ?? "";
    await emit("tool_result", { type: "tool_result", toolName: "read", isError: false, content: [] });
    await emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
    const after = JSON.stringify(await emit("context", { type: "context", messages: [] })) ?? "";
    await emit("tool_result", { type: "tool_result", toolName: "read", isError: true, content: [] });
    await emit("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 2 });
    const failed = JSON.stringify(await emit("context", { type: "context", messages: [] })) ?? "";

    // Then advice states the missing check first and cites the observable result second.
    expect(before).toContain("no successful check");
    expect(after).toContain("read");
    expect(after).toContain("verify");
    expect(after).not.toContain("no successful check");
    expect(failed).toContain("no successful check");
  } finally {
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
});
