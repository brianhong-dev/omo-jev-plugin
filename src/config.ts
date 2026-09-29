import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";

const decisionsSchema = z.strictObject({
  skills: z.boolean().default(true),
  nextAction: z.boolean().default(true),
  toolDiscovery: z.boolean().default(true),
  toolActivation: z.boolean().default(false),
  toolPreflight: z.boolean().default(false),
  resultAssessment: z.boolean().default(true),
  loopDetection: z.boolean().default(true),
  completion: z.boolean().default(true),
  modelRouting: z.boolean().default(false),
  thinkingLevel: z.boolean().default(false),
});

const partialDecisionsSchema = z.strictObject({
  skills: z.boolean().optional(),
  nextAction: z.boolean().optional(),
  toolDiscovery: z.boolean().optional(),
  toolActivation: z.boolean().optional(),
  toolPreflight: z.boolean().optional(),
  resultAssessment: z.boolean().optional(),
  loopDetection: z.boolean().optional(),
  completion: z.boolean().optional(),
  modelRouting: z.boolean().optional(),
  thinkingLevel: z.boolean().optional(),
});

const displaySchema = z.strictObject({
  startup: z.boolean().default(true),
  decisions: z.boolean().default(false),
});

const redactPatternSchema = z.string().min(1).max(128).refine((pattern) => {
  try {
    return !new RegExp(pattern).test("");
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}, "Must be a valid pattern that does not match empty text");

const providerOptionsSchema = z.strictObject({
  model: z.string().min(1).optional(),
  apiKey: z.string().trim().optional(),
  endpoint: z.url().optional(),
});
const providerSchema = z.strictObject({
  selected: z.enum(["jev_compatible", "respan-ai"]).default("jev_compatible"),
  jev_compatible: providerOptionsSchema.prefault({}),
  "respan-ai": providerOptionsSchema.prefault({}),
});
const partialProviderSchema = z.strictObject({
  selected: z.enum(["jev_compatible", "respan-ai"]).optional(),
  jev_compatible: providerOptionsSchema.optional(),
  "respan-ai": providerOptionsSchema.optional(),
});
const configSchema = z.strictObject({
  enabled: z.boolean().default(true),
  autoUpdate: z.boolean().default(false),
  mode: z.enum(["off", "shadow", "advise", "act"]).default("off"),
  experimentalCodeSearch: z.boolean().default(false),
  provider: providerSchema.prefault({}),
  models: z.array(z.string().min(1)).max(16).default([]),
  activatableTools: z.array(z.string().min(1)).max(254).default([]),
  decisions: decisionsSchema.prefault({}),
  display: displaySchema.prefault({}),
  telemetry: z.strictObject({ detailed: z.boolean().default(true) }).prefault({}),
  limits: z.strictObject({
    timeoutMs: z.number().int().min(100).max(30_000).default(1_000),
    spanTimeoutMs: z.number().int().min(100).max(30_000).default(10_000),
    maxCallsPerAgentRun: z.number().int().min(1).max(1_000).default(30),
    stateChars: z.number().int().min(100).max(16_000).default(2_000),
  }).prefault({}),
  thresholds: z.strictObject({
    fit: z.number().min(0).max(1).default(0.6),
    confidence: z.number().min(0).max(1).default(0.65),
    risk: z.number().min(0).max(1).default(0.8),
  }).prefault({}),
  includeToolOutput: z.boolean().default(false),
  includeToolErrors: z.boolean().default(false),
  skillRerank: z.boolean().default(false),
  redactValues: z.array(z.string().min(4)).max(32).default([]),
  redactPatterns: z.array(redactPatternSchema).max(16).default([]),
  preflightOnError: z.enum(["allow", "block"]).default("allow"),
}).refine((value) => !value.experimentalCodeSearch
  || (!value.decisions.toolActivation && !value.decisions.modelRouting && !value.decisions.thinkingLevel), {
  message: "Experimental code search requires toolActivation, modelRouting, and thinkingLevel to be off",
  path: ["experimentalCodeSearch"],
});

type ConfigInput = z.input<typeof configSchema>;
export type PluginConfig = z.output<typeof configSchema>;
const defaultsMigrationId = "jev-defaults-v1";

export function decisionModel(config: PluginConfig): string {
  return config.provider.selected === "respan-ai"
    ? config.provider["respan-ai"].model ?? "respan/span-01-lite"
    : config.provider.jev_compatible.model ?? "jev-1.13.0";
}

export function resolveApiKey(config: PluginConfig, environment = process.env): string | undefined {
  return config.provider.selected === "respan-ai"
    ? config.provider["respan-ai"].apiKey || (environment["OPENROUTER_API_KEY"]?.trim() || undefined)
    : config.provider.jev_compatible.apiKey || (environment["TYPESAFE_API_KEY"]?.trim() || undefined);
}

export class ConfigurationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ConfigurationError";
  }
}

export const globalConfigPath = (): string => join(homedir(), ".omo", "jev-plugin.jsonc");
export const projectConfigPath = (cwd: string): string => join(cwd, ".omo", "jev-plugin.jsonc");

async function readConfig(path: string, migrateDefaults = false): Promise<ConfigInput | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  const firstError = errors[0];
  if (firstError) throw new ConfigurationError(path, printParseErrorCode(firstError.error));
  const result = z.strictObject({
    enabled: z.boolean().optional(),
    autoUpdate: z.boolean().optional(),
    mode: z.enum(["off", "shadow", "advise", "act"]).optional(),
    experimentalCodeSearch: z.boolean().optional(),
    provider: partialProviderSchema.optional(),
    model: z.string().min(1).optional(),
    endpoint: z.url().optional(),
    apiKey: z.string().trim().optional(),
    openrouterApiKey: z.string().trim().optional(),
    models: z.array(z.string().min(1)).optional(),
    activatableTools: z.array(z.string().min(1)).optional(),
    decisions: partialDecisionsSchema.optional(),
    display: z.strictObject({
      startup: z.boolean().optional(),
      decisions: z.boolean().optional(),
    }).optional(),
    telemetry: z.strictObject({ detailed: z.boolean().optional() }).optional(),
    limits: z.strictObject({
      timeoutMs: z.number().int().min(100).max(30_000).optional(),
      spanTimeoutMs: z.number().int().min(100).max(30_000).optional(),
      maxCallsPerAgentRun: z.number().int().min(1).max(1_000).optional(),
      stateChars: z.number().int().min(100).max(16_000).optional(),
    }).optional(),
    thresholds: z.strictObject({
      fit: z.number().min(0).max(1).optional(),
      confidence: z.number().min(0).max(1).optional(),
      risk: z.number().min(0).max(1).optional(),
    }).optional(),
    includeToolOutput: z.boolean().optional(),
    includeToolErrors: z.boolean().optional(),
    skillRerank: z.boolean().optional(),
    redactValues: z.array(z.string().min(4)).max(32).optional(),
    redactPatterns: z.array(redactPatternSchema).max(16).optional(),
    preflightOnError: z.enum(["allow", "block"]).optional(),
    _migrations: z.array(z.string()).optional(),
  }).safeParse(value);
  if (!result.success) throw new ConfigurationError(path, z.prettifyError(result.error));
  if (!migrateDefaults && result.data.telemetry !== undefined) {
    throw new ConfigurationError(path, "Telemetry consent can only be set in the global configuration");
  }
  const { _migrations: history, model, endpoint, apiKey, openrouterApiKey, ...settings } = result.data;
  const legacy = model !== undefined || endpoint !== undefined
    || apiKey !== undefined || openrouterApiKey !== undefined;
  if (legacy && !migrateDefaults) {
    throw new ConfigurationError(path, "Move legacy model, endpoint and API keys under provider");
  }
  const selected: "jev_compatible" | "respan-ai" =
    model === "respan/span-01" || model === "respan/span-01-lite" ? "respan-ai" : "jev_compatible";
  if (legacy && settings.provider) {
    throw new ConfigurationError(path, "Cannot combine legacy model or API keys with provider");
  }
  const migratedSettings = legacy ? {
    ...settings,
    provider: {
      selected,
      jev_compatible: {
        ...(model && selected === "jev_compatible" ? { model } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(!model || selected === "jev_compatible" ? (endpoint ? { endpoint } : {}) : {}),
      },
      "respan-ai": {
        ...(model && selected === "respan-ai" ? { model } : {}),
        ...(openrouterApiKey !== undefined ? { apiKey: openrouterApiKey } : {}),
        ...(selected === "respan-ai" && endpoint ? { endpoint } : {}),
      },
    },
  } : settings;
  if (migrateDefaults && (!history?.includes(defaultsMigrationId) || legacy)) {
    const defaults = configSchema.parse({});
    const formattingOptions = { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" };
    let migrated = source;
    if (legacy) {
      for (const key of ["model", "endpoint", "apiKey", "openrouterApiKey"]) {
        if (Object.hasOwn(result.data, key)) {
          migrated = applyEdits(migrated, modify(migrated, [key], undefined, { formattingOptions }));
        }
      }
      migrated = applyEdits(migrated, modify(migrated, ["provider"], migratedSettings.provider, { formattingOptions }));
    }
    for (const [key, defaultValue] of Object.entries(defaults)) {
      if (key === "telemetry") continue;
      const current = Object.entries(migratedSettings).find(([name]) => name === key)?.[1];
      if (current === undefined) {
        migrated = applyEdits(migrated, modify(migrated, [key], defaultValue, { formattingOptions }));
      } else if (defaultValue !== null && typeof defaultValue === "object" && !Array.isArray(defaultValue)
        && current !== null && typeof current === "object" && !Array.isArray(current)) {
        for (const [child, childDefault] of Object.entries(defaultValue)) {
          if (!Object.hasOwn(current, child)) {
            migrated = applyEdits(migrated, modify(migrated, [key, child], childDefault, { formattingOptions }));
          }
        }
      }
    }
    if (migrated !== source) {
      const nextHistory = history?.includes(defaultsMigrationId)
        ? history : [...history ?? [], defaultsMigrationId];
      migrated = applyEdits(migrated, modify(migrated, ["_migrations"], nextHistory, { formattingOptions }));
      const errors: ParseError[] = [];
      const verified: unknown = parse(migrated, errors, { allowTrailingComma: true });
      const document = z.record(z.string(), z.unknown()).safeParse(verified);
      const { _migrations: applied, ...persisted } = document.success ? document.data : {};
      if (errors.length || !isDeepStrictEqual(applied, nextHistory)
        || !isDeepStrictEqual(configSchema.safeParse(persisted).data, configSchema.parse(migratedSettings))) {
        throw new ConfigurationError(path, "Migration produced an invalid configuration");
      }
      const file = await lstat(path);
      if (!file.isFile()) throw new ConfigurationError(path, "Refusing to migrate a non-regular configuration file");
      const mode = file.mode & 0o777;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let backup = `${path}.bak.${stamp}`;
      for (let suffix = 1; ; suffix++) {
        try {
          await writeFile(backup, source, { encoding: "utf8", flag: "wx", mode });
          break;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          backup = `${path}.bak.${stamp}.${suffix}`;
        }
      }
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, migrated, { encoding: "utf8", flag: "wx", mode });
        if (await readFile(path, "utf8") !== source) {
          throw new ConfigurationError(path, "Configuration changed during migration");
        }
        await rename(temporary, path);
      } catch (error) {
        try {
          await unlink(temporary);
        } catch (cleanupError) {
          if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) {
            throw cleanupError;
          }
        }
        throw error;
      }
    }
  }
  return migratedSettings;
}

export async function loadConfig(
  cwd: string,
  trusted: boolean,
  globalPath = globalConfigPath(),
): Promise<PluginConfig> {
  let global = await readConfig(globalPath, true);
  if (!global) {
    await mkdir(dirname(globalPath), { recursive: true });
    try {
      const { telemetry: _telemetry, ...defaults } = configSchema.parse({});
      await writeFile(globalPath, `${JSON.stringify({ ...defaults, mode: "advise" }, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    global = await readConfig(globalPath, true);
  }
  const local = trusted ? await readConfig(projectConfigPath(cwd)) : undefined;
  return configSchema.parse({
    ...global,
    ...local,
    provider: {
      ...global?.provider,
      ...local?.provider,
      jev_compatible: { ...global?.provider?.jev_compatible, ...local?.provider?.jev_compatible },
      "respan-ai": { ...global?.provider?.["respan-ai"], ...local?.provider?.["respan-ai"] },
    },
    decisions: { ...global?.decisions, ...local?.decisions },
    display: { ...global?.display, ...local?.display },
    telemetry: global?.telemetry,
    limits: { ...global?.limits, ...local?.limits },
    thresholds: { ...global?.thresholds, ...local?.thresholds },
  });
}
