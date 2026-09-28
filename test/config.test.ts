import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError, loadConfig, resolveApiKey } from "../src/config.js";
import { formatDecisionNotice, startupNotice } from "../src/index.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(): Promise<{ cwd: string; globalPath: string; projectPath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "omo-jev-config-"));
  dirs.push(cwd);
  await mkdir(join(cwd, ".omo"));
  return {
    cwd,
    globalPath: join(cwd, "global.jsonc"),
    projectPath: join(cwd, ".omo", "jev-plugin.jsonc"),
  };
}

test("creates a private global configuration with network decisions off", async () => {
  // Given an empty configuration directory.
  const { cwd, globalPath } = await fixture();
  // When config is loaded.
  const config = await loadConfig(cwd, false, globalPath);
  // Then a persisted default leaves network-dependent decisions off.
  expect(config.mode).toBe("off");
  expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual(config);
  expect((await stat(globalPath)).mode & 0o777).toBe(0o600);
});

test("creates a missing configuration directory without creating a project override", async () => {
  // Given a missing global directory and a trusted project.
  const { cwd, projectPath } = await fixture();
  const globalPath = join(cwd, "missing", "nested", "jev-plugin.jsonc");
  // When config is loaded.
  await loadConfig(cwd, true, globalPath);
  // Then only the global file is created.
  expect((await readFile(globalPath, "utf8")).length).toBeGreaterThan(0);
  await expect(readFile(projectPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("preserves existing global settings on repeated loads", async () => {
  // Given an existing configuration with a user choice.
  const { cwd, globalPath } = await fixture();
  const existing = '{ // keep this comment\n "mode": "shadow" }\n';
  await writeFile(globalPath, existing);
  // When the plugin loads the configuration.
  const config = await loadConfig(cwd, false, globalPath);
  // Then the choice and the exact file survive.
  expect(config.mode).toBe("shadow");
  expect(await readFile(globalPath, "utf8")).toBe(existing);
});

test("resolves a configured key before the environment key", async () => {
  // Given both a file key and an environment key.
  const { cwd, globalPath } = await fixture();
  await writeFile(globalPath, '{ "apiKey": "file-key", "endpoint": "https://jev.example.test" }');
  // When config is loaded and the key is resolved.
  const config = await loadConfig(cwd, false, globalPath);
  // Then the file key and endpoint take precedence.
  expect(resolveApiKey(config, { TYPESAFE_API_KEY: "env-key" })).toBe("file-key");
  expect(config.endpoint).toBe("https://jev.example.test");
});

test("uses environment key when the file has none", async () => {
  // Given a file with no API key.
  const { cwd, globalPath } = await fixture();
  await writeFile(globalPath, '{ "mode": "advise" }');
  // When key resolution consults the environment.
  const config = await loadConfig(cwd, false, globalPath);
  // Then whitespace is trimmed and an empty key stays missing.
  expect(resolveApiKey(config, { TYPESAFE_API_KEY: " env-key " })).toBe("env-key");
  expect(resolveApiKey(config, { TYPESAFE_API_KEY: " " })).toBeUndefined();
});

test("reports enabled options without exposing the configured key", async () => {
  // Given an active configuration with a key and selected decisions.
  const { cwd, globalPath } = await fixture();
  await writeFile(globalPath, '{ "mode": "advise", "apiKey": "private-key", "endpoint": "https://jev.example.test" }');
  const config = await loadConfig(cwd, false, globalPath);
  // When the startup notice is prepared.
  const notice = startupNotice(config, { TYPESAFE_API_KEY: "env-key" });
  // Then the effective options and key source are selected without exposing the key.
  expect(notice?.type).toBe("info");
  expect(notice?.options?.mode).toBe("advise");
  expect(notice?.options?.keySource).toBe("file");
  expect(notice?.options?.decisions).toContain("skills");
  expect(notice?.message).not.toContain("private-key");
});

test("shows missing-key warning at startup", async () => {
  // Given an enabled configuration with no key from either source.
  const { cwd, globalPath } = await fixture();
  await writeFile(globalPath, '{ "mode": "advise" }');
  // When the startup notice is prepared.
  const notice = startupNotice(await loadConfig(cwd, false, globalPath), {});
  // Then the user is informed immediately.
  expect(notice?.type).toBe("warning");
  expect(notice?.options).toBeUndefined();
});

test("does not announce inactive execution with a configured key", async () => {
  // Given a deliberately disabled configuration.
  const { cwd, globalPath } = await fixture();
  await writeFile(globalPath, '{ "mode": "off", "apiKey": "private-key" }');
  // When the startup notice is prepared.
  const notice = startupNotice(await loadConfig(cwd, false, globalPath), {});
  // Then it does not claim the plugin is active.
  expect(notice).toBeUndefined();
});

test("startup display switch suppresses only successful startup notices", async () => {
  // Given an active configuration that hides startup details.
  const { cwd, globalPath } = await fixture();
  await writeFile(globalPath, '{ "mode": "advise", "apiKey": "private-key", "display": { "startup": false } }');
  const config = await loadConfig(cwd, false, globalPath);
  // When startup status is selected.
  const notice = startupNotice(config, {});
  // Then the successful status is suppressed while the decision switch keeps its default.
  expect(notice).toBeUndefined();
  expect(config.display.decisions).toBe(false);
});

test("project display override preserves the other global display switch", async () => {
  // Given different global and trusted-project display settings.
  const { cwd, globalPath, projectPath } = await fixture();
  await writeFile(globalPath, '{ "display": { "startup": false, "decisions": false } }');
  await writeFile(projectPath, '{ "display": { "decisions": true } }');
  // When the trusted project settings are loaded.
  const config = await loadConfig(cwd, true, globalPath);
  // Then only the selected switch changes.
  expect(config.display).toEqual({ startup: false, decisions: true });
});

test("decision notices expose typed outcomes without secret inputs", () => {
  // Given a decision and a secret-bearing request not present in its typed fields.
  const decision = { tool: "read", looping: false, complete: true };
  // When turn and preflight notices are formatted.
  const turn = formatDecisionNotice({ kind: "turn", decision });
  const preflight = formatDecisionNotice({ kind: "preflight", tool: "read", blocked: true });
  // Then only selected IDs and outcomes are visible.
  expect(turn).toContain("read");
  expect(preflight).toContain("read");
  expect(turn).not.toContain("private-key");
  expect(preflight).not.toContain("private-key");
});

test("merges trusted project overrides without erasing global decisions", async () => {
  // Given different global and project values.
  const { cwd, globalPath, projectPath } = await fixture();
  await writeFile(globalPath, '{ "mode": "advise", "decisions": { "skills": false, "nextAction": true }, "limits": { "timeoutMs": 1200 } }');
  await writeFile(projectPath, '{ "mode": "act", "decisions": { "nextAction": false }, "limits": { "maxCallsPerAgentRun": 3 }, }');
  // When the project is trusted.
  const config = await loadConfig(cwd, true, globalPath);
  // Then project keys win and unrelated global keys survive.
  expect(config.mode).toBe("act");
  expect(config.decisions.skills).toBe(false);
  expect(config.decisions.nextAction).toBe(false);
  expect(config.limits.timeoutMs).toBe(1200);
  expect(config.limits.maxCallsPerAgentRun).toBe(3);
});

test("ignores untrusted project overrides", async () => {
  // Given a project file that would enable actions.
  const { cwd, globalPath, projectPath } = await fixture();
  await writeFile(globalPath, '{ "mode": "shadow" }');
  await writeFile(projectPath, '{ "mode": "act" }');
  // When project trust has not been granted.
  const config = await loadConfig(cwd, false, globalPath);
  // Then the project file has no effect.
  expect(config.mode).toBe("shadow");
});

test("rejects malformed JSONC instead of silently disabling the plugin", async () => {
  // Given malformed global config.
  const { cwd, globalPath } = await fixture();
  await writeFile(globalPath, '{ "mode": "act", /* not closed');
  // When loading the config.
  const result = loadConfig(cwd, false, globalPath);
  // Then the error identifies the file.
  await expect(result).rejects.toBeInstanceOf(ConfigurationError);
});

test("rejects malformed redaction patterns at the config boundary", async () => {
  // Given a pattern that cannot be compiled.
  const { cwd, globalPath } = await fixture();
  await writeFile(globalPath, '{ "redactPatterns": ["("] }');
  // When the configuration is loaded, the malformed expression is rejected.
  await expect(loadConfig(cwd, false, globalPath)).rejects.toBeInstanceOf(ConfigurationError);
});

test("rejects redaction patterns that match empty text", async () => {
  // Given a pattern that would replace at every position.
  const { cwd, globalPath } = await fixture();
  await writeFile(globalPath, '{ "redactPatterns": ["a*"] }');
  // When the configuration is loaded, the unbounded match is rejected.
  await expect(loadConfig(cwd, false, globalPath)).rejects.toBeInstanceOf(ConfigurationError);
});
