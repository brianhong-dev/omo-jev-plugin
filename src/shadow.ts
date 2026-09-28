import { z } from "zod";

export const shadowFeedbackSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  recommended: z.string().optional(),
  followed: z.boolean(),
  succeeded: z.boolean().optional(),
  firstTool: z.string().optional(),
  toolCalls: z.number().int().nonnegative().default(0),
  repeatedErrors: z.number().int().nonnegative().default(0),
  checkSucceeded: z.boolean().default(false),
});

export type ShadowFeedback = z.output<typeof shadowFeedbackSchema>;

export function isSuccessfulCheck(toolName: string, input: Record<string, unknown>, isError: boolean): boolean {
  if (isError || (toolName !== "bash" && toolName !== "powershell")) return false;
  const command = input["command"];
  return typeof command === "string"
    && /(?:^|[;&|]\s*)(?:bun test|bun run (?:check|build)|npm test|npm run (?:check|build)|npx tsc)\b/.test(command);
}

export function replayShadow(entries: readonly {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}[]): {
  readonly turns: number;
  readonly recommended: number;
  readonly followed: number;
  readonly successful: number;
  readonly checksAfterFollowed: number;
  readonly baselineDifferences: number;
  readonly repeatedErrors: number;
} {
  const result = {
    turns: 0, recommended: 0, followed: 0, successful: 0,
    checksAfterFollowed: 0, baselineDifferences: 0, repeatedErrors: 0,
  };
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "jev:feedback") continue;
    const parsed = shadowFeedbackSchema.safeParse(entry.data);
    if (!parsed.success) continue;
    const turn = parsed.data;
    result.turns++;
    if (turn.recommended) result.recommended++;
    if (turn.followed) result.followed++;
    if (turn.followed && turn.succeeded) result.successful++;
    if (turn.followed && turn.checkSucceeded) result.checksAfterFollowed++;
    if (turn.recommended && turn.firstTool && turn.recommended !== turn.firstTool) result.baselineDifferences++;
    result.repeatedErrors += turn.repeatedErrors;
  }
  return result;
}
