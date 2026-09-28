import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
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

const configSchema = z.strictObject({
  enabled: z.boolean().default(true),
  mode: z.enum(["off", "shadow", "advise", "act"]).default("off"),
  model: z.string().min(1).default("jev-1.13.0"),
  endpoint: z.url().optional(),
  apiKey: z.string().trim().min(1).optional(),
  models: z.array(z.string().min(1)).max(16).default([]),
  activatableTools: z.array(z.string().min(1)).max(254).default([]),
  decisions: decisionsSchema.prefault({}),
  display: displaySchema.prefault({}),
  limits: z.strictObject({
    timeoutMs: z.number().int().min(100).max(30_000).default(1_000),
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
  preflightOnError: z.enum(["allow", "block"]).default("allow"),
});

type ConfigInput = z.input<typeof configSchema>;
export type PluginConfig = z.output<typeof configSchema>;

export function resolveApiKey(config: PluginConfig, environment = process.env): string | undefined {
  return config.apiKey ?? (environment["TYPESAFE_API_KEY"]?.trim() || undefined);
}

export class ConfigurationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ConfigurationError";
  }
}

export const globalConfigPath = (): string => join(homedir(), ".omo", "jev-plugin.jsonc");
export const projectConfigPath = (cwd: string): string => join(cwd, ".omo", "jev-plugin.jsonc");

async function readConfig(path: string): Promise<ConfigInput | undefined> {
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
    mode: z.enum(["off", "shadow", "advise", "act"]).optional(),
    model: z.string().min(1).optional(),
    endpoint: z.url().optional(),
    apiKey: z.string().trim().min(1).optional(),
    models: z.array(z.string().min(1)).optional(),
    activatableTools: z.array(z.string().min(1)).optional(),
    decisions: partialDecisionsSchema.optional(),
    display: z.strictObject({
      startup: z.boolean().optional(),
      decisions: z.boolean().optional(),
    }).optional(),
    limits: z.strictObject({
      timeoutMs: z.number().int().min(100).max(30_000).optional(),
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
    preflightOnError: z.enum(["allow", "block"]).optional(),
  }).safeParse(value);
  if (!result.success) throw new ConfigurationError(path, z.prettifyError(result.error));
  return result.data;
}

export async function loadConfig(
  cwd: string,
  trusted: boolean,
  globalPath = globalConfigPath(),
): Promise<PluginConfig> {
  let global = await readConfig(globalPath);
  if (!global) {
    await mkdir(dirname(globalPath), { recursive: true });
    try {
      await writeFile(globalPath, `${JSON.stringify(configSchema.parse({}), null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    global = await readConfig(globalPath);
  }
  const local = trusted ? await readConfig(projectConfigPath(cwd)) : undefined;
  return configSchema.parse({
    ...global,
    ...local,
    decisions: { ...global?.decisions, ...local?.decisions },
    display: { ...global?.display, ...local?.display },
    limits: { ...global?.limits, ...local?.limits },
    thresholds: { ...global?.thresholds, ...local?.thresholds },
  });
}
