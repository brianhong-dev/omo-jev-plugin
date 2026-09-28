import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";

const installationInfoSchema = z.strictObject({
  schemaVersion: z.literal(1),
  installationId: z.uuid(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  lastPluginVersion: z.string().min(1),
  sessionStarts: z.number().int().nonnegative(),
});

export type InstallationInfo = z.infer<typeof installationInfoSchema>;
export const installationInfoPath = (): string => join(homedir(), ".omo", "jev-plugin-info.jsonc");

export type TelemetryMetadata = {
  readonly omoSessionId: string | null;
  readonly pluginProvider: "jev_compatible" | "respan-ai" | null;
  readonly pluginModel: string | null;
  readonly llmModel: string | null;
  readonly thinkingEffort: string | null;
};

export type TelemetryEvent = TelemetryMetadata & (
  | { readonly type: "session_started"; readonly schemaVersion: 1; readonly installationId: string; readonly pluginVersion: string }
  | { readonly type: "session_summary"; readonly schemaVersion: 2; readonly installationId: string;
    readonly pluginVersion: string; readonly mode: "off" | "shadow" | "advise" | "act";
    readonly provider: "jev_compatible" | "respan-ai" }
  | { readonly type: "turn_usage"; readonly schemaVersion: 1; readonly installationId: string;
    readonly pluginVersion: string; readonly usageSessionId: string; readonly eventId: string;
    readonly turnIndex: number; readonly inputTokens: number; readonly outputTokens: number;
    readonly estimatedCost: number | null }
  | { readonly type: "decision_recorded"; readonly schemaVersion: 1; readonly installationId: string;
    readonly pluginVersion: string; readonly decisionKind: "turn" | "preflight" | "code_search";
    readonly outcome: "success" | "error"; readonly recommendationMade: boolean;
    readonly blocked: boolean | null; readonly inputTokens: number;
    readonly outputTokens: number; readonly estimatedCost: number | null });

export interface TelemetryExporter {
  send(event: TelemetryEvent): Promise<void>;
  flush?(): Promise<void>;
}

export class NoopTelemetryExporter implements TelemetryExporter {
  async send(_event: TelemetryEvent): Promise<void> {}
}

export class TelemetryRecorder {
  constructor(private readonly exporter: TelemetryExporter = new NoopTelemetryExporter()) {}

  async sessionStarted(info: InstallationInfo, metadata: TelemetryMetadata): Promise<void> {
    await this.exporter.send({
      type: "session_started", schemaVersion: 1,
      installationId: info.installationId, pluginVersion: info.lastPluginVersion,
      ...metadata,
    });
    await this.exporter.flush?.();
  }

  async sessionSummary(consented: boolean, event: Extract<TelemetryEvent, { type: "session_summary" }>): Promise<void> {
    if (consented) await this.exporter.send(event);
  }

  async turnUsage(consented: boolean, event: Extract<TelemetryEvent, { type: "turn_usage" }>): Promise<void> {
    if (consented) await this.exporter.send(event);
  }

  async decision(consented: boolean, event: Extract<TelemetryEvent, { type: "decision_recorded" }>): Promise<void> {
    if (consented) await this.exporter.send(event);
  }

  async flush(): Promise<void> {
    await this.exporter.flush?.();
  }
}

export async function updateInstallationInfo(
  pluginVersion: string,
  path = installationInfoPath(),
  now = new Date(),
): Promise<InstallationInfo> {
  await mkdir(dirname(path), { recursive: true });
  let previous: InstallationInfo | undefined;
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`Not a regular installation information file: ${path}`);
    const source = await readFile(path, "utf8");
    const errors: ParseError[] = [];
    const value: unknown = parse(source, errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(`Invalid installation information: ${path}`);
    previous = installationInfoSchema.parse(value);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const timestamp = now.toISOString();
  const info: InstallationInfo = {
    schemaVersion: 1,
    installationId: previous?.installationId ?? randomUUID(),
    firstSeenAt: previous?.firstSeenAt ?? timestamp,
    lastSeenAt: timestamp,
    lastPluginVersion: pluginVersion,
    sessionStarts: (previous?.sessionStarts ?? 0) + 1,
  };
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(info, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) throw cleanupError;
    }
    throw error;
  }
  return info;
}
