import { expect, test } from "bun:test";
import { classifyFailure, planRecovery } from "../src/recovery.js";

test("classifies bounded failures without storing error text in a plan", () => {
  // Given common diagnostic categories.
  const failures = [
    "ENOENT: missing file",
    "EACCES: permission denied",
    "request timed out",
    "HTTP 503 from server",
    "unknown tool failure",
  ];
  // When errors are classified.
  const categories = failures.map(classifyFailure);
  // Then the plan needs only a safe diagnostic category.
  expect(categories).toEqual(["missing-path", "permission", "timeout", "http", "other"]);
});

test("plans an alternative after observed failure without inventing a tool", () => {
  // Given an actual failed read and a validated alternative.
  const attempts = [{ tool: "read", failed: true, failure: "missing-path" }] as const;
  // When stalled progress is assessed.
  const plan = planRecovery(true, attempts, "grep");
  // Then the plan links the next tool to the observed failure.
  expect(plan).toEqual({
    kind: "failure", tool: "read", failure: "missing-path", alternativeTool: "grep",
  });
});

test("does not plan a recovery when progress improves", () => {
  // Given a recent failed tool and an alternative.
  // When the next judgment no longer indicates a stall.
  const plan = planRecovery(false, [{ tool: "read", failed: true }], "grep");
  // Then no recovery advice is produced.
  expect(plan).toBeUndefined();
});
