import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Candidate } from "./decision.js";

const execFileAsync = promisify(execFile);
const sourceExtension = /\.(?:c|cc|cpp|cs|go|h|java|js|jsx|kt|mjs|php|py|rb|rs|sh|swift|ts|tsx)$/i;
const maxFiles = 48;
const maxFileBytes = 64 * 1024;
const linesPerWindow = 20;
const maxWindowsPerFile = 24;

export type CodeSearchRequest = {
  readonly cwd: string;
  readonly query: string;
  readonly scope?: string | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type CodeSearchRank = (
  query: string,
  candidates: readonly Candidate[],
  signal?: AbortSignal,
) => Promise<readonly number[]>;

export class CodeSearchError extends Error {
  constructor(readonly reason: "scope" | "repository" | "limit", message: string) {
    super(message);
    this.name = "CodeSearchError";
  }
}

export async function searchCode(request: CodeSearchRequest, rank: CodeSearchRank): Promise<string> {
  const root = await realpath(request.cwd);
  const scope = request.scope ?? ".";
  if (scope !== "." && (scope.split(/[\\/]/).some((part) => part === ".." || part.startsWith("."))
    || resolve(root, scope) === root || resolve(root, scope).startsWith(`${root}${sep}`) === false)) {
    throw new CodeSearchError("scope", "Search path must be a non-hidden directory inside this project");
  }
  const directory = await realpath(resolve(root, scope));
  if (directory !== root && !directory.startsWith(`${root}${sep}`)) {
    throw new CodeSearchError("scope", "Search path must stay inside this project");
  }
  let listed: string;
  try {
    const result = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", scope], {
      cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal: request.signal,
    });
    listed = result.stdout;
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw new CodeSearchError("repository", "Code search requires a Git repository");
  }
  const paths = [...new Set(listed.split("\0").filter(Boolean))].sort()
    .filter((path) => sourceExtension.test(path)
      && path.split("/").every((part) => !part.startsWith("."))
      && !/(\.env|\.pem|\.key|credentials|secrets)/i.test(path));
  if (paths.length > maxFiles) {
    throw new CodeSearchError("limit", `${paths.length} eligible files exceed the ${maxFiles}-file search limit; narrow path`);
  }

  const files: { readonly path: string; readonly lines: readonly string[]; readonly preview: string }[] = [];
  for (const path of paths) {
    request.signal?.throwIfAborted();
    const absolute = resolve(root, path);
    if (relative(root, absolute).startsWith("..")) continue;
    const stat = await lstat(absolute).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat?.isFile() || stat.size > maxFileBytes) continue;
    const canonical = await realpath(absolute).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!canonical || canonical !== absolute) continue;
    const text = await readFile(canonical, "utf8");
    if (text.includes("\0")) continue;
    files.push({
      path,
      lines: text.split("\n"),
      preview: `${text.slice(0, 700)}\n...\n${text.slice(-350)}`,
    });
  }
  if (files.length === 0) return "No eligible source files found in the selected path.";

  const selected = await rank(request.query, files.map((file) => ({
    name: file.path, description: file.preview,
  })), request.signal);
  if (selected.length === 0) return `No relevant files found among ${files.length} inspected source files.`;

  const windows: { readonly path: string; readonly start: number; readonly text: string }[] = [];
  const leads: string[] = [];
  let totalWindows = 0;
  for (const index of selected) {
    const file = files[index];
    if (!file) continue;
    leads.push(file.path);
    const count = Math.ceil(file.lines.length / linesPerWindow);
    const sampled = Math.min(count, maxWindowsPerFile);
    totalWindows += count;
    for (let windowIndex = 0; windowIndex < sampled; windowIndex++) {
      const start = (sampled === 1 ? 0
        : Math.round(windowIndex * (count - 1) / (sampled - 1))) * linesPerWindow;
      windows.push({
        path: file.path,
        start: start + 1,
        text: file.lines.slice(start, start + linesPerWindow).join("\n").slice(0, 1600),
      });
    }
  }
  if (windows.length === 0) return `Relevant files: ${leads.join(", ")} (no source excerpts available).`;
  const matches = await rank(request.query, windows.map((window) => ({
    name: `${window.path}:${window.start}`,
    description: window.text,
  })), request.signal);
  const excerpts = matches.flatMap((index) => {
    const window = windows[index];
    if (!window) return [];
    const numbered = window.text.split("\n")
      .map((line, offset) => `${window.start + offset}: ${line}`).join("\n");
    return [`${window.path}:${window.start}\n${numbered}`];
  });
  return [
    `Relevant files: ${leads.join(", ")}`,
    `Inspected ${files.length} files; ${windows.length}/${totalWindows} source windows${windows.length < totalWindows
      ? " (sampled across longer files; read listed files for complete coverage)" : ""}.`,
    excerpts.length ? excerpts.join("\n\n") : "No matching excerpt in the inspected windows; read the listed files directly.",
  ].join("\n\n");
}
