import { expect, test } from "bun:test";
import { checkVersion, installedVersion } from "../src/update.js";

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
  expect(current).toBe("0.0.4");
});
