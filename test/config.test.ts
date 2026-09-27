import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError, loadConfig } from "../src/config.js";

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

test("leaves network decisions off when no configuration exists", async () => {
  // Given an empty configuration directory.
  const { cwd, globalPath } = await fixture();
  // When config is loaded.
  const config = await loadConfig(cwd, false, globalPath);
  // Then no network-dependent decision is active.
  expect(config.mode).toBe("off");
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
