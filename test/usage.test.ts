import { expect, test } from "bun:test";
import { addUsage, emptyUsage, formatUsage, usageEntrySchema } from "../src/usage.js";

test("sums Jev 1.13 tokens and input-only cost across requests", () => {
  // Given two priced responses in one turn.
  const first = { input_tokens: 1_000_000, output_tokens: 20 };
  const second = { input_tokens: 500_000, output_tokens: 30 };
  // When their usage is combined.
  const total = addUsage(addUsage(emptyUsage, first, "jev-1.13.0"), second, "jev-1.13.0");
  // Then output tokens are counted but not billed.
  expect(total).toEqual({ inputTokens: 1_500_000, outputTokens: 50, estimatedCost: 0.063 });
});

test("does not report a misleading price for an unknown model", () => {
  // Given a priced request followed by a model without published pricing.
  const priced = addUsage(emptyUsage, { input_tokens: 100, output_tokens: 1 }, "jev-1.13.0");
  // When both are included in the session total.
  const total = addUsage(priced, { input_tokens: 200, output_tokens: 2 }, "custom-model");
  // Then token counts remain accurate while the full-session price is unavailable.
  expect(total).toEqual({ inputTokens: 300, outputTokens: 3, estimatedCost: null });
  expect(formatUsage(total)).toContain("unavailable");
});

test("formats small charges without rounding them to zero", () => {
  // Given a single input token at the published price.
  const total = addUsage(emptyUsage, { input_tokens: 1, output_tokens: 0 }, "jev-1.13.0");
  // When the history label is formatted.
  const label = formatUsage(total);
  // Then the displayed estimate remains nonzero.
  expect(label).toContain("$0.00000004");
});

test("accepts a persisted turn and session usage record", () => {
  // Given a prior turn and its cumulative session total.
  const record = {
    turnIndex: 1,
    turn: addUsage(emptyUsage, { input_tokens: 2, output_tokens: 1 }, "jev-1.13.0"),
    session: addUsage(emptyUsage, { input_tokens: 5, output_tokens: 3 }, "jev-1.13.0"),
  };
  // When a session restores the stored entry.
  const restored = usageEntrySchema.parse(record);
  // Then its session total can continue accumulating separately from the turn.
  expect(addUsage(restored.session, { input_tokens: 7, output_tokens: 4 }, "jev-1.13.0").inputTokens).toBe(12);
  expect(restored.turn.inputTokens).toBe(2);
});
