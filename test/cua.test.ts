import { expect, test } from "bun:test";
import { createEventBus, createExtensionRuntime } from "@code-yeongyu/senpi";
import { loadExtensionFromFactory } from "../node_modules/@code-yeongyu/senpi/dist/core/extensions/loader.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { JevDecider } from "../src/decision.js";
import { bindObservation, registerCua } from "../src/cua.js";

for (const scenario of ["success", "no_action", "action_error", "blocked", "observation_error"] as const) {
  test(`CUA observes and dispatches through host permissions: ${scenario}`, async () => {
    // Given real SDK HTTP transport, a host execution boundary, and changing snapshots.
    const dir = await mkdtemp(join(tmpdir(), "jev-cua-"));
    const calls: string[] = [];
    let observations = 0;
    const server = Bun.serve({ port: 0, async fetch(req) {
      const body = await req.json();
      const choosing = Boolean(body.questions.action);
      return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 5, output_tokens: 0 }, answers: choosing ? {
        action: { type: "choice", choice: scenario === "no_action" ? "__none__" : "press",
          confidence: 0.95, probabilities: { press: 0.95, __none__: 0.05 } },
        actionFits: { type: "noul", noul: 0.95 },
      } : { verified: { type: "noul", noul: 0.95 }, changed: { type: "noul", noul: 0.95 } } });
    } });
    try {
      const config = await loadConfig(dir, false, join(dir, "global.jsonc"));
      config.provider.jev_compatible = { apiKey: "test", endpoint: server.url.href };
      const decider = new JevDecider(config);
      const runtime = createExtensionRuntime();
      runtime.getActiveTools = () => ["observe", "click"];
      runtime.executeTool = async <TDetails>(tool: string, params: unknown) => {
        calls.push(tool);
        if (tool === "observe") {
          observations++;
          return { content: [{ type: "text", text: JSON.stringify({
            elements: [{ element_token: `fresh-${observations}` }], value: observations === 1 ? "0" : "2",
          }) }], details: z.custom<TDetails>().parse({}), ...(scenario === "observation_error" ? { isError: true } : {}) };
        }
        expect(params).toEqual({ element_token: "fresh-1" });
        if (scenario === "blocked") throw new Error("host permission blocked");
        return { content: [], details: z.custom<TDetails>().parse({}), ...(scenario === "action_error" ? { isError: true } : {}) };
      };
      const extension = await loadExtensionFromFactory((pi) => registerCua(pi, {
        decider: () => decider, availableCalls: () => 2,
      }), dir, createEventBus(), runtime);
      const tool = extension.tools.get("jev_cua_step");
      if (!tool) throw new Error("CUA tool not registered");
      const params = { goal: "Show 2", observation: { tool: "observe", params: {} }, actions: [{
        id: "press", description: "Press 2", expectedResult: "Display shows 2",
        invocation: { tool: "click", params: { element_token: "$observation.elements.0.element_token" } },
      }] };
      // When the registered tool executes a single step.
      const run = Reflect.apply(tool.definition.execute, undefined, ["test", params, undefined, undefined, {}]);
      if (scenario === "blocked" || scenario === "observation_error") {
        await expect(run).rejects.toThrow();
        expect(calls).toEqual(scenario === "blocked" ? ["observe", "click"] : ["observe"]);
      } else {
        const result = z.object({ details: z.object({ status: z.string(), verified: z.boolean().optional() }) }).parse(await run);
        // Then fresh handles are used, post-observation occurs, and failures never verify success.
        expect(calls).toEqual(scenario === "no_action" ? ["observe"] : ["observe", "click", "observe"]);
        expect(result.details.status).toBe(scenario === "success" ? "assessed"
          : scenario === "action_error" ? "action_failed" : "no_action");
        if (scenario !== "no_action") expect(result.details.verified).toBe(scenario === "success");
      }
    } finally {
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("rejects a snapshot binding absent from the fresh observation", () => {
  expect(() => bindObservation("$observation.elements.2.element_token", { elements: [] })).toThrow();
});
