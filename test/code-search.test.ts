import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { searchCode, CodeSearchError } from "../src/code-search.js";
import { loadConfig } from "../src/config.js";
import { JevDecider } from "../src/decision.js";
import jevPlugin from "../src/index.js";

const execFileAsync = promisify(execFile);

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "omo-jev-search-"));
  await execFileAsync("git", ["init", "-q", cwd]);
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, ".gitignore"), "ignored.ts\n");
  await writeFile(join(cwd, "ignored.ts"), "ignored secret");
  await writeFile(join(cwd, "src", "credentials.ts"), "private secret");
  await writeFile(join(cwd, "src", "auth.ts"),
    `${Array.from({ length: 24 }, (_, index) => `export const line${index} = ${index};`).join("\n")}
export function rejectExpiredToken() { return false; }
`);
  await writeFile(join(cwd, "src", "other.ts"), "export const unrelated = true;\n");
  return cwd;
}

test("returns original source lines after Jev selects a file and window", async () => {
  // Given a Git project and a local endpoint exercising the SDK's real request path.
  const cwd = await repository();
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const payload: unknown = await request.json();
      if (!payload || typeof payload !== "object" || !("questions" in payload)
        || !payload.questions || typeof payload.questions !== "object") {
        return Response.json({ error: "Invalid questions" }, { status: 400 });
      }
      const questions = Object.entries(payload.questions);
      received.push(JSON.stringify(payload.questions));
      const answers = Object.fromEntries(questions.map(([key, value]) => {
        const text = JSON.stringify(value);
        return [key, { type: "noul", noul: text.includes("auth.ts") && (
          !text.includes("other.ts") && (received.length === 1 || text.includes("rejectExpiredToken"))
        ) ? 0.95 : 0.1 }];
      }));
      return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 50, output_tokens: 0 } });
    },
  });
  try {
    const config = await loadConfig(cwd, false, join(cwd, "global.jsonc"));
    const client = new TypeSafeClient({
      apiKey: "local-test-key", baseURL: `http://127.0.0.1:${server.port}`, retry: { maxRetries: 0 },
    });
    const decider = new JevDecider(config, client);
    // When search ranks files and then source windows through the real SDK transport.
    const output = await searchCode({ cwd, query: "Where are expired tokens rejected?" },
      (query, candidates, signal) => decider.rankCode(query, candidates, signal));
    // Then only the matching verbatim excerpt reaches the agent, with its real line.
    expect(output).toContain("src/auth.ts:21");
    expect(output).toContain("25: export function rejectExpiredToken() { return false; }");
    expect(output).not.toContain("private secret");
    expect(received).toHaveLength(2);
    expect(received.join(" ")).not.toContain("ignored secret");
    expect(received.join(" ")).not.toContain("private secret");
  } finally {
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects an escaping search path before sending source", async () => {
  // Given a project with source and a path outside it.
  const cwd = await repository();
  let calls = 0;
  try {
    // When a caller requests a parent path.
    await expect(searchCode({ cwd, query: "auth", scope: "../" }, async () => {
      calls++;
      return [0];
    })).rejects.toMatchObject({ reason: "scope" } satisfies Partial<CodeSearchError>);
    // Then no content is sent to a model.
    expect(calls).toBe(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("does not upload a file reached through a symlinked directory", async () => {
  // Given a tracked file whose parent directory is later replaced by an external symlink.
  const cwd = await repository();
  const outside = await mkdtemp(join(tmpdir(), "omo-jev-outside-"));
  let calls = 0;
  try {
    await mkdir(join(cwd, "vault"));
    await writeFile(join(cwd, "vault", "private.ts"), "export const harmless = true;\n");
    await execFileAsync("git", ["-C", cwd, "add", "vault/private.ts"]);
    await rm(join(cwd, "vault"), { recursive: true });
    await writeFile(join(outside, "private.ts"), "export const outsideSecret = 'not-for-jev';\n");
    await symlink(outside, join(cwd, "vault"));
    // When Git lists the tracked path whose content now resolves outside the root.
    const output = await searchCode({ cwd, query: "outside secret" }, async (_query, candidates) => {
      calls++;
      expect(JSON.stringify(candidates)).not.toContain("outsideSecret");
      return [];
    });
    // Then no external source is uploaded or returned.
    expect(output).not.toContain("outsideSecret");
    expect(calls).toBeGreaterThan(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("does not upload ignored source reached through an in-project directory symlink", async () => {
  // Given a tracked path whose parent is replaced by a symlink to an ignored directory.
  const cwd = await repository();
  let calls = 0;
  try {
    await mkdir(join(cwd, "vault"));
    await writeFile(join(cwd, "vault", "private.ts"), "export const harmless = true;\n");
    await execFileAsync("git", ["-C", cwd, "add", "vault/private.ts"]);
    await rm(join(cwd, "vault"), { recursive: true });
    await mkdir(join(cwd, ".ignored"));
    await writeFile(join(cwd, ".ignored", "private.ts"), "export const insideHiddenSecret = true;\n");
    await symlink(join(cwd, ".ignored"), join(cwd, "vault"));

    // When Git still lists the tracked path, the provider must not see its hidden target.
    const output = await searchCode({ cwd, query: "hidden secret" }, async (_query, candidates) => {
      calls++;
      expect(JSON.stringify(candidates)).not.toContain("insideHiddenSecret");
      return [];
    });

    expect(output).not.toContain("insideHiddenSecret");
    expect(calls).toBeGreaterThan(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("finds evidence near the end of a long source file", async () => {
  // Given a relevant source declaration past the initial window budget.
  const cwd = await repository();
  try {
    await writeFile(join(cwd, "src", "long.ts"),
      `${Array.from({ length: 620 }, (_, index) => `const filler${index} = ${index};`).join("\n")}
export function rejectExpiredToken() { return false; }
`);
    // When the file and source windows are ranked.
    const output = await searchCode({ cwd, query: "expired token", scope: "src" },
      async (_query, candidates) => candidates.flatMap((candidate, index) =>
        candidate.name === "src/long.ts" || candidate.description.includes("rejectExpiredToken")
          ? [index] : []).slice(0, 3));
    // Then the late declaration retains its original path and line number.
    expect(output).toContain("621: export function rejectExpiredToken() { return false; }");
    expect(output).toContain("src/long.ts:621");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("requires a narrower path before evaluating too many files", async () => {
  // Given more eligible files than one bounded search allows.
  const cwd = await repository();
  let calls = 0;
  try {
    for (let index = 0; index < 48; index++) {
      await writeFile(join(cwd, "src", `more-${index}.ts`), `export const n = ${index};`);
    }
    // When the broad search exceeds the candidate budget.
    await expect(searchCode({ cwd, query: "auth" }, async () => {
      calls++;
      return [0];
    })).rejects.toMatchObject({ reason: "limit" } satisfies Partial<CodeSearchError>);
    // Then the client makes no unbounded Jev request.
    expect(calls).toBe(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("registers the opt-in search at startup and executes without switching session settings", async () => {
  // Given a trusted Git project, its override, and a local decision endpoint.
  const cwd = await repository();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const notices: string[] = [];
  let searchTool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const payload: unknown = await request.json();
      if (!payload || typeof payload !== "object" || !("questions" in payload)
        || !payload.questions || typeof payload.questions !== "object") {
        return Response.json({ error: "Invalid questions" }, { status: 400 });
      }
      const answers = Object.fromEntries(Object.entries(payload.questions).map(([key, value]) =>
        [key, { type: "noul", noul: JSON.stringify(value).includes("auth.ts") ? 0.95 : 0.1 }]));
      return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 30, output_tokens: 0 } });
    },
  });
  try {
    await mkdir(join(cwd, ".omo"));
    await writeFile(join(cwd, ".omo", "jev-plugin.jsonc"), JSON.stringify({
      mode: "advise", experimentalCodeSearch: true,
      provider: { jev_compatible: { apiKey: "local-key", endpoint: `http://127.0.0.1:${server.port}` } },
      decisions: { toolActivation: false, modelRouting: false, thinkingLevel: false },
    }));
    globalThis.fetch = Object.assign(
      async (url: RequestInfo | URL, init?: RequestInit) =>
        url === "https://registry.npmjs.org/omo-jev-plugin/latest"
          ? Response.json({ version: "0.0.7" }) : originalFetch(url, init),
      { preconnect: originalFetch.preconnect },
    );
    const handlers = new Map<string, (event: object, ctx: object) => Promise<void>>();
    Reflect.apply(jevPlugin, undefined, [{
      on: (name: string, handler: (event: object, ctx: object) => Promise<void>) => handlers.set(name, handler),
      registerEntryRenderer: () => {},
      registerCommand: () => {},
      appendEntry: () => {},
      registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => { searchTool = tool; },
      getActiveTools: () => [],
      setActiveTools: () => { calls.push("tools"); },
      setSessionModel: async () => { calls.push("model"); return true; },
      setSessionThinkingLevel: () => { calls.push("thinking"); },
    }]);
    const ctx = {
      cwd, isProjectTrusted: () => true, sessionManager: { getBranch: () => [] },
      ui: { notify: (message: string) => { notices.push(message); } },
      modelRegistry: { getAvailable: () => [] }, signal: undefined,
    };
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);
    // When the agent invokes the tool registered before its first model call.
    const tool = searchTool;
    if (!tool) throw new Error(`Experimental search tool was not registered: ${notices.join("; ")}`);
    const result: unknown = await Reflect.apply(tool.execute, tool,
      ["call-1", { query: "Find the expired token check", path: "src" }, undefined, undefined, ctx]);
    // Then the result contains bounded source evidence without changing cached-prefix settings.
    expect(tool.exposure).toBe("eval");
    expect(JSON.stringify(result)).toContain("src/auth.ts:1");
    expect(calls).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
});
