import { APIError, TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import { decisionModel, resolveApiKey, type PluginConfig } from "./config.js";

// A transport lives for the session, not just for one agent run.
export class TypeSafeTransport {
  private readonly primary: TypeSafeClient;
  private readonly local: TypeSafeClient | undefined;
  private exhausted = false;

  constructor(config: PluginConfig, client?: TypeSafeClient) {
    const apiKey = resolveApiKey(config);
    this.primary = client ?? new TypeSafeClient({
      ...(apiKey ? { apiKey } : {}),
      ...(config.provider.jev_compatible.endpoint ? { baseURL: config.provider.jev_compatible.endpoint } : {}),
      defaultModel: decisionModel(config),
      timeout: config.limits.timeoutMs,
      retry: { maxRetries: 0 },
      logLevel: "off",
    });
    const fallback = config.provider.localFallback;
    this.local = fallback ? new TypeSafeClient({
      apiKey: fallback.apiKey || "local",
      baseURL: fallback.endpoint,
      defaultModel: fallback.model,
      timeout: fallback.timeoutMs,
      retry: { maxRetries: 0 },
      logLevel: "off",
    }) : undefined;
  }

  async systemOne(state: Record<string, string | string[]>, questions: Questions, signal?: AbortSignal) {
    const options = signal ? { signal } : {};
    if (this.exhausted && this.local) return this.local.systemOne({ state, questions }, options);
    try {
      return await this.primary.systemOne({ state, questions }, options);
    } catch (error) {
      // Ordinary rate limiting is not proof that account credits are exhausted.
      if (!(error instanceof APIError) || !this.local || signal?.aborted) throw error;
      const detail = typeof error.body === "string" ? error.body : JSON.stringify(error.body) ?? "";
      if (error.status !== 402 && !([403, 429].includes(error.status)
        && /insufficient[_\s-]*(?:quota|credits?|balance)|(?:quota|credits?|balance|tokens?)[^\n]{0,80}(?:exhausted|depleted)|(?:quota|credit)[_\s-]*(?:exceeded|limit[_\s-]*reached)/i.test(detail))) {
        throw error;
      }
      this.exhausted = true;
      return this.local.systemOne({ state, questions }, options);
    }
  }
}
