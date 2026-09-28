import { readFile } from "node:fs/promises";
import { z } from "zod";

const versionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const registrySchema = z.object({ version: versionSchema });

export async function installedVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  return z.object({ version: versionSchema }).parse(manifest).version;
}

export async function checkVersion(
  current: string,
  registryUrl = "https://registry.npmjs.org/omo-jev-plugin/latest",
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<{ status: "current" | "update"; version: string } | undefined> {
  try {
    const response = await request(registryUrl, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return;
    const { version } = registrySchema.parse(await response.json());
    const installed = versionSchema.parse(current).split(".").map(Number);
    const latest = version.split(".").map(Number);
    for (let index = 0; index < 3; index++) {
      const available = latest[index];
      const local = installed[index];
      if (available === undefined || local === undefined) return;
      if (available > local) return { status: "update", version };
      if (available < local) return { status: "current", version };
    }
    return { status: "current", version };
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
}
