import type { TelemetryEvent, TelemetryExporter } from "./telemetry.js";

// PostHog project tokens are public ingestion identifiers, not personal API keys.
const defaultProjectToken = "phc_s1dG0C10qnMkgza1XJk76gKnbAqp6nkn7uxQqCpTKtU";

export class PostHogExporter implements TelemetryExporter {
  constructor(
    private readonly projectToken = defaultProjectToken,
    private readonly host = "https://us.i.posthog.com",
    private readonly request: typeof fetch = fetch,
  ) {}

  async send(event: TelemetryEvent): Promise<void> {
    const { installationId, type, ...properties } = event;
    const response = await this.request(new URL("/i/v0/e/", this.host), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.projectToken,
        distinct_id: installationId,
        event: `jev_plugin_${type}`,
        properties: { ...properties, $process_person_profile: false, $geoip_disable: true },
      }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`PostHog capture returned HTTP ${response.status}`);
  }
}
