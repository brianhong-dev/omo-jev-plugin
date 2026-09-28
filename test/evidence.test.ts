import { expect, test } from "bun:test";
import { requirementsFromRequest, verificationKind } from "../src/evidence.js";

test("extracts bounded numbered requirements and reports omitted criteria", () => {
  // Given a request with more independent requirements than a Jev turn can map.
  const request = Array.from({ length: 7 }, (_, index) => `${index + 1}. Check requirement ${index + 1}`).join("\n");
  // When the request is split for evidence mapping.
  const result = requirementsFromRequest(request);
  // Then six criteria are tracked and the omitted one prevents a completion claim.
  expect(result.items).toHaveLength(6);
  expect(result.truncated).toBe(true);
});

test("treats a request without a list as one criterion", () => {
  // Given a prose request.
  // When it is prepared for evidence mapping.
  const result = requirementsFromRequest("Check the user-visible output.");
  // Then it remains a single requirement.
  expect(result).toEqual({ items: ["Check the user-visible output."], truncated: false });
});

test("classifies check commands without interpreting ordinary tool success as evidence", () => {
  // Given successful-looking invocation metadata from different tools.
  // When their verification kinds are classified.
  const kinds = [
    verificationKind("bash", { command: "bun test test/evidence.test.ts" }),
    verificationKind("bash", { command: "bun run build" }),
    verificationKind("bash", { command: "curl -fsS http://localhost:3000/health" }),
    verificationKind("read", { path: "src/index.ts" }),
  ];
  // Then only recognizable checks are eligible for direct-evidence selection.
  expect(kinds).toEqual(["test", "build", "behavior", undefined]);
});
