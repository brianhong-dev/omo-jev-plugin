import { expect, test } from "bun:test";
import { PostHogExporter } from "../src/posthog.js";
import { TelemetryRecorder } from "../src/telemetry.js";

test("posts only typed session-start fields as an anonymous PostHog event", async () => {
  // Given a local HTTP capture endpoint and a project token.
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/i/v0/e/");
      requests.push(await request.json());
      return Response.json({ status: 1 });
    },
  });
  try {
    const exporter = new PostHogExporter("test-project-token", `http://127.0.0.1:${server.port}`);
    // When a session-start event is exported.
    await exporter.send({
      type: "session_started", schemaVersion: 1,
      installationId: "01234567-89ab-4def-8123-456789abcdef", pluginVersion: "0.0.8",
    });
    // Then the wire payload identifies the installation without creating a person profile.
    expect(requests).toEqual([{
      api_key: "test-project-token",
      distinct_id: "01234567-89ab-4def-8123-456789abcdef",
      event: "jev_plugin_session_started",
      properties: {
        schemaVersion: 1, pluginVersion: "0.0.8",
        $process_person_profile: false, $geoip_disable: true,
      },
    }]);
  } finally {
    server.stop(true);
  }
});

test("uses the bundled project token without environment configuration", async () => {
  // Given an HTTP endpoint substituting only the network destination.
  let token: unknown;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const payload: unknown = await request.json();
      if (payload && typeof payload === "object" && "api_key" in payload) token = payload.api_key;
      return Response.json({ status: 1 });
    },
  });
  try {
    // When the exporter is constructed without a project token.
    await new PostHogExporter(undefined, `http://127.0.0.1:${server.port}`).send({
      type: "session_started", schemaVersion: 1,
      installationId: "01234567-89ab-4def-8123-456789abcdef", pluginVersion: "0.0.8",
    });
    // Then the built-in public ingestion token enables capture.
    expect(token).toMatch(/^phc_[A-Za-z0-9]+$/);
  } finally {
    server.stop(true);
  }
});

test("posts a detailed summary only when the recorder receives consent", async () => {
  // Given a local PostHog-compatible endpoint and an exporter.
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      return Response.json({ status: 1 });
    },
  });
  try {
    const recorder = new TelemetryRecorder(new PostHogExporter("token", `http://127.0.0.1:${server.port}`));
    const summary = {
      type: "session_summary" as const, schemaVersion: 1 as const,
      installationId: "01234567-89ab-4def-8123-456789abcdef",
      pluginVersion: "0.0.8", mode: "shadow" as const, provider: "jev_compatible" as const,
      decisionCalls: 2, inputTokens: 50, outputTokens: 1, estimatedCost: null,
    };
    // When detailed consent is absent, then granted.
    await recorder.sessionSummary(false, summary);
    expect(requests).toEqual([]);
    await recorder.sessionSummary(true, summary);
    // Then only the consented payload reaches PostHog.
    expect(requests).toEqual([{
      api_key: "token", distinct_id: summary.installationId,
      event: "jev_plugin_session_summary",
      properties: {
        schemaVersion: 1, pluginVersion: "0.0.8", mode: "shadow",
        provider: "jev_compatible", decisionCalls: 2,
        inputTokens: 50, outputTokens: 1, estimatedCost: null,
        $process_person_profile: false, $geoip_disable: true,
      },
    }]);
  } finally {
    server.stop(true);
  }
});
