import { z } from "zod";
import type { ExtensionEvent } from "@latticeag/events";
import { StageNotImplementedError } from "../errors.js";
import type { BreakLoopInput } from "../types.js";
import type { StageExecuteContext } from "./types.js";

export const breakLoopInputSchema: z.ZodType<BreakLoopInput> = z
  .object({
    window: z.array(
      z
        .object({
          name: z.string(),
          arguments: z.record(z.string(), z.any()).optional(),
          result: z.any().optional(),
        })
        .strict(),
    ),
    beliefs: z.array(z.any()).optional(),
  })
  .strict();

export async function executeBreakLoop(
  input: BreakLoopInput,
  ctx: StageExecuteContext,
): Promise<ExtensionEvent> {
  breakLoopInputSchema.parse(input);
  void ctx;
  throw new StageNotImplementedError(
    "STAGE_NOT_IMPLEMENTED",
    "LexLoop registers id break_loop",
    "break_loop",
  );
}
