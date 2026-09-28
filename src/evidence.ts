export type VerificationResult = {
  readonly id: string;
  readonly tool: string;
  readonly kind: "test" | "build" | "behavior";
  readonly detail?: string;
};

export function requirementsFromRequest(request: string): {
  readonly items: readonly string[];
  readonly truncated: boolean;
} {
  const listed = request.split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)/);
      return match?.[1] ? [match[1]] : [];
    });
  const items = listed.length ? listed : [request.trim()];
  return { items: items.slice(0, 6), truncated: items.length > 6 };
}

export function verificationKind(
  tool: string,
  input: Record<string, unknown>,
): VerificationResult["kind"] | undefined {
  if (tool !== "bash" && tool !== "powershell") return;
  const command = input["command"];
  if (typeof command !== "string") return;
  if (/(?:^|[;&|]\s*)(?:bun test|npm test)\b/.test(command)) return "test";
  if (/(?:^|[;&|]\s*)(?:bun run (?:check|build)|npm run (?:check|build)|npx tsc)\b/.test(command)) {
    return "build";
  }
  if (/(?:^|[;&|]\s*)curl\s+(?:--fail(?:-with-body)?\b|-[a-zA-Z]*f[a-zA-Z]*\b)/.test(command)) {
    return "behavior";
  }
}
