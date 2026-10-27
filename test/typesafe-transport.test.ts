import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { JevDecider } from "../src/decision.js";

for (const failure of [
  { status: 402, body: { error: "Payment required" }, fallback: true },
  { status: 429, body: { error: { code: "insufficient_quota" } }, fallback: true },
  { status: 403, body: { error: "Token quota exhausted" }, fallback: true },
  { status: 429, body: { error: "Rate limit exceeded" }, fallback: false },
  { status: 401, body: { error: "Invalid key" }, fallback: false },
  { status: 500, body: { error: "Server error" }, fallback: false },
]) {
  test(`routes session requests after HTTP ${failure.status}: ${JSON.stringify(failure.body)}`, async () => {
    // Given a primary that succeeds once, then fails, and a local fallback.
    const calls: string[] = [];
    const answer = (model: string) => Response.json({
      model, answers: { outsideScope: { type: "noul", noul: 0.2 } },
      usage: { input_tokens: 5, output_tokens: 0 },
    });
    const primary = Bun.serve({ port: 0, fetch() {
      calls.push("primary");
      return calls.length === 1 ? answer("jev-1.13.0")
        : Response.json(failure.body, { status: failure.status });
    } });
    const local = Bun.serve({ port: 0, async fetch(req) {
      const body = await req.json();
      calls.push(`local:${body.model}`);
      expect(req.headers.get("authorization")).toBe("Bearer local-key");
      return answer(body.model);
    } });
    const dir = await mkdtemp(join(tmpdir(), "jev-fallback-"));
    try {
      const path = join(dir, "global.jsonc");
      await writeFile(path, JSON.stringify({ provider: {
        selected: "jev_compatible",
        jev_compatible: { apiKey: "primary-key", endpoint: primary.url.href },
        localFallback: { endpoint: local.url.href, model: "laya-1.0", apiKey: "local-key", timeoutMs: 1000 },
      } }));
      const decider = new JevDecider(await loadConfig(dir, false, path));
      // When one session issues requests before and after exhaustion.
      expect(await decider.risk("Inspect", "read", {})).toBe(0.2);
      if (failure.fallback) {
        expect(await decider.risk("Inspect again", "read", {})).toBe(0.2);
        expect(await decider.risk("Next turn", "read", {})).toBe(0.2);
        // Then later turns stay local, without retrying the depleted primary.
        expect(calls).toEqual(["primary", "primary", "local:laya-1.0", "local:laya-1.0"]);
      } else {
        await expect(decider.risk("Inspect again", "read", {})).rejects.toMatchObject({ status: failure.status });
        expect(calls).toEqual(["primary", "primary"]);
      }
    } finally {
      primary.stop(true);
      local.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });
}
