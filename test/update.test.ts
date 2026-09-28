import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersion, installedVersion, updatePlugin } from "../src/update.js";

test("reports a newer npm version across semver segments", async () => {
  // Given the registry's latest version.
  const request = async () => Response.json({ version: "0.0.10" });
  // When compared to the installed version.
  const available = await checkVersion("0.0.3", undefined, request);
  // Then the newer version is reported using numeric segments.
  expect(available).toEqual({ status: "update", version: "0.0.10" });
});

test("reports the installed or an older registry version as current", async () => {
  // Given two registry versions that are not newer.
  const same = async () => Response.json({ version: "0.0.3" });
  const older = async () => Response.json({ version: "0.0.2" });
  // When compared to the installed version.
  const results = await Promise.all([
    checkVersion("0.0.3", undefined, same),
    checkVersion("0.0.3", undefined, older),
  ]);
  // Then neither triggers an update notice.
  expect(results).toEqual([
    { status: "current", version: "0.0.3" },
    { status: "current", version: "0.0.2" },
  ]);
});

test("continues without an update when the registry fails", async () => {
  // Given an unavailable registry.
  const request = async () => new Response(null, { status: 503 });
  // When the check runs.
  const available = await checkVersion("0.0.3", undefined, request);
  // Then startup can continue without a notice.
  expect(available).toBeUndefined();
});

test("reads the installed version from the package manifest", async () => {
  // Given the actual package entrypoint.
  // When its version is read.
  const current = await installedVersion();
  // Then it matches the version used to build this checkout.
  expect(current).toBe("0.0.8");
});

test("runs the OmO extension updater without a shell", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-jev-update-command-"));
  const launcher = join(dir, "launcher.mjs");
  const output = join(dir, "args.json");
  const previous = process.env["OMO_BIN"];
  try {
    await writeFile(launcher, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`);
    process.env["OMO_BIN"] = launcher;
    await updatePlugin();
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(["update", "npm:omo-jev-plugin"]);
  } finally {
    if (previous === undefined) delete process.env["OMO_BIN"];
    else process.env["OMO_BIN"] = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
