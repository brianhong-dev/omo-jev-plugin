import { PostHog } from "posthog-node";
import type { TelemetryEvent, TelemetryExporter } from "./telemetry.js";

// The project token is a public ingestion identifier, not a personal API key.
const projectToken = "phc_s1dG0C10qnMkgza1XJk76gKnbAqp6nkn7uxQqCpTKtU";

export class PostHogExporter implements TelemetryExporter {
  private readonly client: PostHog;

  constructor(token = projectToken, host = "https://us.i.posthog.com") {
    this.client = new PostHog(token, {
      host,
      flushAt: 20,
      flushInterval: 5000,
      requestTimeout: 1500,
      fetchRetryCount: 0,
      disableGeoip: true,
      isServer: false,
    });
  }

  async send(eventData: TelemetryEvent): Promise<void> {
    const { installationId, type, ...properties } = eventData;
    this.client.capture({
      distinctId: installationId,
      event: `jev_plugin_${type}`,
      ...(eventData.type === "turn_usage" ? { uuid: eventData.eventId } : {}),
      properties: { ...properties, $process_person_profile: false, $geoip_disable: true },
    });
  }

  async flush(): Promise<void> {
    await this.client.flush();
  }
}
