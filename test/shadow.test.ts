import { expect, test } from "bun:test";
import { isSuccessfulCheck, replayShadow } from "../src/shadow.js";

test("replays observed recommendations without treating divergence as causal impact", () => {
  // Given persisted shadow feedback, including a legacy record and unrelated session entry.
  const entries = [
    { type: "custom", customType: "jev:feedback", data: {
      turnIndex: 0, recommended: "read", followed: true, succeeded: true,
      firstTool: "read", toolCalls: 2, checkSucceeded: true, repeatedErrors: 0,
    } },
    { type: "custom", customType: "jev:feedback", data: {
      turnIndex: 1, recommended: "bash", followed: false,
      firstTool: "read", toolCalls: 3, checkSucceeded: true, repeatedErrors: 1,
    } },
    { type: "custom", customType: "jev:feedback", data: {
      turnIndex: 2, followed: false, toolCalls: 1, repeatedErrors: 0, checkSucceeded: false,
    } },
    { type: "custom", customType: "jev:feedback", data: {
      turnIndex: 3, recommended: "read", followed: true, succeeded: false,
    } },
    { type: "custom", customType: "jev:feedback", data: { recommended: 3 } },
    { type: "custom", customType: "jev:usage", data: { turnIndex: 2 } },
  ];
  // When the recorded branch is replayed without another Jev call.
  const report = replayShadow(entries);
  // Then counts describe observed behavior, not a hypothetical act-mode outcome.
  expect(report).toEqual({
    turns: 4, recommended: 3, followed: 2, successful: 1,
    checksAfterFollowed: 1, baselineDifferences: 1, repeatedErrors: 1,
  });
});

test("recognizes successful check commands without counting ordinary tool calls", () => {
  // Given completed check and ordinary commands.
  const checks = [
    isSuccessfulCheck("bash", { command: "bun test test/config.test.ts" }, false),
    isSuccessfulCheck("bash", { command: "cd repo && bun run build" }, false),
    isSuccessfulCheck("bash", { command: "bun test" }, true),
    isSuccessfulCheck("bash", { command: "git status" }, false),
    isSuccessfulCheck("read", { command: "bun test" }, false),
  ];
  // When their check signals are classified.
  // Then only the successful check invocations contribute to the proxy metric.
  expect(checks).toEqual([true, true, false, false, false]);
});
