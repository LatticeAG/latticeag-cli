import { z } from "zod";
import type { JsonObject, JsonValue, ToolObservedEvent } from "@latticeag/events";
import type { ObserveToolInput } from "../types.js";
import type { StageExecuteContext } from "./types.js";

const visreplayProducer = {
  product: "visreplay" as const,
  adapter: "@latticeag/adapter-visreplay",
  adapter_version: "0.1.0",
};

const axionProducer = {
  product: "axion" as const,
  adapter: "@latticeag/adapter-axion",
  adapter_version: "0.1.0",
};

export const observeToolInputSchema: z.ZodType<ObserveToolInput> = z
  .object({
    source: z.enum(["axion", "visreplay"]),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.any()) as z.ZodType<JsonObject>,
    result: z.any().optional() as z.ZodType<JsonValue | undefined>,
    error: z.string().optional(),
    argument_fingerprint: z.string().optional(),
    visreplay_event_id: z.string().optional(),
    axion_action_id: z.string().optional(),
    causation_id: z.string().optional(),
  })
  .strict() as z.ZodType<ObserveToolInput>;

export async function executeObserveTool(
  input: ObserveToolInput,
  ctx: StageExecuteContext,
  previous: Map<string, ToolObservedEvent>,
): Promise<ToolObservedEvent> {
  const parsed = observeToolInputSchema.parse(input);
  const dupKey =
    parsed.visreplay_event_id !== undefined
      ? `vr:${parsed.visreplay_event_id}`
      : parsed.axion_action_id !== undefined
        ? `ax:${parsed.axion_action_id}`
        : undefined;
  if (dupKey !== undefined) {
    const existing = previous.get(dupKey);
    if (existing) {
      return existing;
    }
  }

  const producer = parsed.source === "axion" ? axionProducer : visreplayProducer;
  const event = (await ctx.bus.emit({
    name: "tool_observed",
    payload: {
      source: parsed.source,
      name: parsed.name,
      arguments: parsed.arguments,
      ...(parsed.result !== undefined ? { result: parsed.result } : {}),
      ...(parsed.error !== undefined ? { error: parsed.error } : {}),
      ...(parsed.argument_fingerprint !== undefined
        ? { argument_fingerprint: parsed.argument_fingerprint }
        : {}),
      ...(parsed.visreplay_event_id !== undefined
        ? { visreplay_event_id: parsed.visreplay_event_id }
        : {}),
      ...(parsed.axion_action_id !== undefined ? { axion_action_id: parsed.axion_action_id } : {}),
    },
    producer,
    correlation_id: ctx.run_id,
    ...(parsed.causation_id !== undefined ? { causation_id: parsed.causation_id } : {}),
  })) as ToolObservedEvent;

  if (dupKey !== undefined) {
    previous.set(dupKey, event);
  }
  return event;
}
