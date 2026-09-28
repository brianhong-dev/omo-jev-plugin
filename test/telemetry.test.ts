import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { TelemetryRecorder, updateInstallationInfo, type TelemetryEvent } from "../src/telemetry.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("preserves installation identity and counts session starts across updates", async () => {
  // Given an empty private directory.
  const directory = await mkdtemp(join(tmpdir(), "omo-jev-info-"));
  directories.push(directory);
  const path = join(directory, "jev-plugin-info.jsonc");
  // When two sessions start with different plugin versions.
  const first = await updateInstallationInfo("0.0.8", path, new Date("2026-09-28T01:00:00Z"));
  const second = await updateInstallationInfo("0.0.9", path, new Date("2026-09-28T02:00:00Z"));
  // Then the local record retains the ID and first-seen time while updating session facts.
  expect(first.installationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(second).toEqual({
    schemaVersion: 1, installationId: first.installationId,
    firstSeenAt: "2026-09-28T01:00:00.000Z",
    lastSeenAt: "2026-09-28T02:00:00.000Z",
    lastPluginVersion: "0.0.9", sessionStarts: 2,
  });
  expect(parse(await readFile(path, "utf8"))).toEqual(second);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("does not overwrite malformed installation information", async () => {
  // Given a file whose identity cannot be trusted.
  const directory = await mkdtemp(join(tmpdir(), "omo-jev-info-"));
  directories.push(directory);
  const path = join(directory, "jev-plugin-info.jsonc");
  await writeFile(path, "{ invalid json");
  // When a session attempts to update it.
  await expect(updateInstallationInfo("0.0.8", path)).rejects.toThrow();
  // Then the original file remains available for recovery.
  expect(await readFile(path, "utf8")).toBe("{ invalid json");
});

test("does not follow an installation information symlink", async () => {
  // Given a link to another file in place of the managed record.
  const directory = await mkdtemp(join(tmpdir(), "omo-jev-info-"));
  directories.push(directory);
  const target = join(directory, "target.jsonc");
  const path = join(directory, "jev-plugin-info.jsonc");
  await writeFile(target, "{}");
  await symlink(target, path);
  // When the plugin updates its installation information.
  await expect(updateInstallationInfo("0.0.8", path)).rejects.toThrow(/Not a regular/);
  // Then it leaves the linked file untouched.
  expect(await readFile(target, "utf8")).toBe("{}");
});

test("records a basic session without sending details unless consented", async () => {
  // Given a replaceable exporter and an installation record.
  const events: TelemetryEvent[] = [];
  const recorder = new TelemetryRecorder({ async send(event) { events.push(event); } });
  const info = {
    schemaVersion: 1 as const, installationId: "01234567-89ab-4def-8123-456789abcdef",
    firstSeenAt: "2026-09-28T01:00:00.000Z", lastSeenAt: "2026-09-28T01:00:00.000Z",
    lastPluginVersion: "0.0.8", sessionStarts: 1,
  };
  const summary = {
    type: "session_summary" as const, schemaVersion: 1 as const,
    installationId: info.installationId, pluginVersion: "0.0.8",
    mode: "shadow" as const, provider: "jev_compatible" as const,
    decisionCalls: 2, inputTokens: 100, outputTokens: 5, estimatedCost: 0.001,
  };
  // When a session starts and detailed consent is absent.
  await recorder.sessionStarted(info);
  await recorder.sessionSummary(false, summary);
  // Then only the minimal event reaches the exporter.
  expect(events).toEqual([{
    type: "session_started", schemaVersion: 1,
    installationId: info.installationId, pluginVersion: "0.0.8",
  }]);
  // When consent is explicitly supplied.
  await recorder.sessionSummary(true, summary);
  // Then the replaceable exporter receives the summary.
  expect(events[1]).toEqual(summary);
});
