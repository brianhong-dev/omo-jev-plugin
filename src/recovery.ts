export type FailureKind = "missing-path" | "permission" | "timeout" | "http" | "other";

export type Attempt = {
  readonly tool: string;
  readonly failed: boolean;
  readonly failure?: FailureKind;
};

export type RecoveryPlan = {
  readonly kind: "failure" | "stalled";
  readonly tool: string;
  readonly failure?: FailureKind;
  readonly alternativeTool?: string;
};

export function classifyFailure(output: string): FailureKind {
  if (/\b(?:ENOENT|not found|no such file)\b/i.test(output)) return "missing-path";
  if (/\b(?:EACCES|EPERM|permission denied)\b/i.test(output)) return "permission";
  if (/\b(?:ETIMEDOUT|timeout|timed out)\b/i.test(output)) return "timeout";
  if (/\b(?:HTTP\s*[45]\d\d|status\s*[45]\d\d)\b/i.test(output)) return "http";
  return "other";
}

export function planRecovery(
  stalled: boolean,
  attempts: readonly Attempt[],
  alternativeTool?: string,
): RecoveryPlan | undefined {
  if (!stalled) return;
  const latest = attempts.at(-1);
  if (!latest) return;
  return {
    kind: latest.failed ? "failure" : "stalled",
    tool: latest.tool,
    ...(latest.failure ? { failure: latest.failure } : {}),
    ...(alternativeTool ? { alternativeTool } : {}),
  };
}
