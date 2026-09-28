import type { Usage } from "@typesafe-ai/sdk";
import { z } from "zod";

export const usageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCost: z.number().nonnegative().nullable(),
});

export const usageEntrySchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  turn: usageTotalsSchema,
  session: usageTotalsSchema,
});

export type UsageTotals = z.infer<typeof usageTotalsSchema>;

export const emptyUsage: UsageTotals = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };

export function addUsage(
  total: UsageTotals,
  usage: Usage & { readonly cost?: number | undefined },
  model: string,
): UsageTotals {
  const cost = usage.cost ?? (
    model === "jev-1.13.0" ? usage.input_tokens * 0.042 / 1_000_000
      : /^respan\/span-01-lite(?:-\d{8})?$/.test(model) ? 0
        : /^respan\/span-01(?:-\d{8})?$/.test(model) ? usage.input_tokens * 0.02 / 1_000_000
          : null
  );
  return {
    inputTokens: total.inputTokens + usage.input_tokens,
    outputTokens: total.outputTokens + usage.output_tokens,
    estimatedCost: total.estimatedCost === null || cost === null ? null : total.estimatedCost + cost,
  };
}

export function formatUsage(total: UsageTotals): string {
  const cost = total.estimatedCost === null ? "unavailable" : `~$${total.estimatedCost.toFixed(8)}`;
  return `input ${total.inputTokens.toLocaleString()} / output ${total.outputTokens.toLocaleString()} tokens | ${cost}`;
}
