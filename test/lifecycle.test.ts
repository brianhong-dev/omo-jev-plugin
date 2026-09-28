import { expect, test } from "bun:test";
import { createEventBus, createExtensionRuntime } from "@code-yeongyu/senpi";
import { loadExtensionFromFactory } from "../node_modules/@code-yeongyu/senpi/dist/core/extensions/loader.js";
import { getThemeByName } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/theme/theme.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
