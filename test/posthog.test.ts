import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { PostHogExporter } from "../src/posthog.js";
import { TelemetryRecorder, type TelemetryMetadata } from "../src/telemetry.js";

const metadata: TelemetryMetadata = {
  omoSessionId: "session-123",
  pluginProvider: "jev_compatible",
  pluginModel: "jev-1.13.0",
  llmModel: "openai/gpt-6",
  thinkingEffort: "high",
};
const installationId = "01234567-89ab-4def-8123-456789abcdef";

async function captureBody(request: Request): Promise<unknown> {
  const bytes = Buffer.from(await request.arrayBuffer());
  return JSON.parse(request.headers.get("content-encoding") === "gzip"
    ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8"));
}

test("sends session metadata immediately through the PostHog batch endpoint", async () => {
  // Given a local capture endpoint and an isolated project token.
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/batch/");
      requests.push(await captureBody(request));
      return Response.json({ status: 1 });
    },
  });
  try {
    const recorder = new TelemetryRecorder(new PostHogExporter("test-token", `http://127.0.0.1:${server.port}`));
    // When the session starts, without waiting for a shutdown.
    await recorder.sessionStarted({
      schemaVersion: 1, installationId, firstSeenAt: "2026-09-28T00:00:00.000Z",
      lastSeenAt: "2026-09-28T00:00:00.000Z", lastPluginVersion: "0.0.8", sessionStarts: 1,
    }, metadata);
    // Then a single anonymous event is already delivered.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      api_key: "test-token",
      batch: [{
        distinct_id: installationId,
        event: "jev_plugin_session_started",
        properties: {
          schemaVersion: 1, pluginVersion: "0.0.8", ...metadata,
          $process_person_profile: false, $geoip_disable: true,
        },
      }],
    });
  } finally {
    server.stop(true);
  }
});

test("uses the bundled public project token", async () => {
  // Given a local endpoint substituting only the network destination.
  let token: unknown;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const payload = await captureBody(request);
      if (payload && typeof payload === "object" && "api_key" in payload) token = payload.api_key;
      return Response.json({ status: 1 });
    },
  });
  try {
    const exporter = new PostHogExporter(undefined, `http://127.0.0.1:${server.port}`);
    await exporter.send({
      type: "session_started", schemaVersion: 1, installationId, pluginVersion: "0.0.8", ...metadata,
    });
    await exporter.flush();
    expect(token).toMatch(/^phc_[A-Za-z0-9]+$/);
  } finally {
    server.stop(true);
  }
});

test("batches consented decisions, turn usage, and summary but not unconsented details", async () => {
  // Given a local PostHog endpoint and a recorder.
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await captureBody(request));
      return Response.json({ status: 1 });
    },
  });
  try {
    const recorder = new TelemetryRecorder(new PostHogExporter("token", `http://127.0.0.1:${server.port}`));
    const decision = {
      type: "decision_recorded" as const, schemaVersion: 1 as const, installationId,
      pluginVersion: "0.0.8", ...metadata, decisionKind: "turn" as const,
      outcome: "success" as const, recommendationMade: true, blocked: null,
      inputTokens: 20, outputTokens: 1, estimatedCost: 0.001,
    };
    const summary = {
      type: "session_summary" as const, schemaVersion: 2 as const, installationId,
      pluginVersion: "0.0.8", ...metadata, mode: "shadow" as const,
      provider: "jev_compatible" as const,
    };
    const usage = {
      type: "turn_usage" as const, schemaVersion: 1 as const, installationId,
      pluginVersion: "0.0.8", ...metadata,
      usageSessionId: "session-123", eventId: "19af32a7-04bf-442e-8940-c2611d333005",
      turnIndex: 0,
      inputTokens: 20, outputTokens: 1, estimatedCost: 0.001,
    };
    // When the decision, turn usage, and summary are consented.
    await recorder.decision(false, decision);
    await recorder.sessionSummary(false, summary);
    await recorder.turnUsage(false, usage);
    expect(requests).toEqual([]);
    await recorder.decision(true, decision);
    await recorder.sessionSummary(true, summary);
    await recorder.turnUsage(true, usage);
    expect(requests).toEqual([]);
    await recorder.flush();
    // Then all three reach PostHog together, with no extra event.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      api_key: "token",
      batch: [
        { distinct_id: installationId, event: "jev_plugin_decision_recorded",
          properties: { schemaVersion: 1, pluginVersion: "0.0.8", ...metadata,
            decisionKind: "turn", outcome: "success", recommendationMade: true,
            blocked: null, inputTokens: 20, outputTokens: 1, estimatedCost: 0.001,
            $process_person_profile: false, $geoip_disable: true } },
        { distinct_id: installationId, event: "jev_plugin_session_summary",
          properties: { schemaVersion: 2, pluginVersion: "0.0.8", ...metadata,
            mode: "shadow", provider: "jev_compatible",
            $process_person_profile: false, $geoip_disable: true } },
        { distinct_id: installationId, event: "jev_plugin_turn_usage",
          uuid: usage.eventId,
          properties: { schemaVersion: 1, pluginVersion: "0.0.8", ...metadata,
            usageSessionId: "session-123", eventId: usage.eventId, turnIndex: 0,
            inputTokens: 20, outputTokens: 1, estimatedCost: 0.001,
            $process_person_profile: false, $geoip_disable: true } },
      ],
    });
  } finally {
    server.stop(true);
  }
});
