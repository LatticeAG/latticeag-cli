import { z } from "zod";
import type { CompensationExecutedEvent } from "@latticeag/events";
import { StageNotImplementedError } from "../errors.js";
import type { CompensateInput } from "../types.js";
import type { StageExecuteContext } from "./types.js";

export const compensateInputSchema: z.ZodType<CompensateInput> = z
  .object({
    request_id: z.string().min(1),
    execution_id: z.string().min(1),
    action: z.string(),
    note: z.string().optional(),
    state_to: z.enum(["failed_verified", "invalidated", "executed"]),
  })
  .strict();

export async function executeCompensate(
  input: CompensateInput,
  ctx: StageExecuteContext,
): Promise<CompensationExecutedEvent> {
  compensateInputSchema.parse(input);
  void ctx;
  throw new StageNotImplementedError(
    "STAGE_NOT_IMPLEMENTED",
    "VekRevert registers id compensate; v0.1 metadata compensation stays on the VekInbox adapter",
    "compensate",
  );
}
