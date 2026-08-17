import { z } from "zod";
import type { PolicyDecisionEvent } from "@latticeag/events";
import { StageDisabledError } from "../errors.js";
import type { ShieldInput } from "../types.js";
import type { StageExecuteContext } from "./types.js";

export const shieldInputSchema: z.ZodType<ShieldInput> = z
  .object({
    tool: z.string().min(1),
    arguments: z.record(z.string(), z.any()).optional(),
    causation_id: z.string().optional(),
  })
  .strict();

export async function executeShield(
  input: ShieldInput,
  ctx: StageExecuteContext,
): Promise<PolicyDecisionEvent> {
  shieldInputSchema.parse(input);
  void ctx;
  throw new StageDisabledError(
    "STAGE_DISABLED",
    "product: lexshield. wrapToolWithLexshield stays in @latticeag/lexshield. v0.1 shield is post-hoc unless the caller invokes shield before the tool.",
    "shield",
  );
}
