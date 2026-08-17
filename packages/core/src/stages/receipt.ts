import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { z } from "zod";
import type { ReceiptIssuedEvent } from "@latticeag/events";
import type { ReceiptInput } from "../types.js";
import type { StageExecuteContext } from "./types.js";

export const receiptInputSchema: z.ZodType<ReceiptInput> = z
  .object({
    request_id: z.string().min(1),
    execution_id: z.string().min(1).optional(),
    action: z.string(),
    payload_bytes: z.instanceof(Uint8Array),
    issued_at: z.string().optional(),
  })
  .strict();

const VEK_PRODUCER = {
  product: "vekinbox" as const,
  adapter: "@latticeag/adapter-vekinbox",
  adapter_version: "0.1.0",
};

export function payloadSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function executeReceipt(
  input: ReceiptInput,
  ctx: StageExecuteContext,
): Promise<ReceiptIssuedEvent> {
  const parsed = receiptInputSchema.parse(input);
  const payload_sha256 = payloadSha256(parsed.payload_bytes);
  const execution_id = parsed.execution_id ?? `exec_${ulid()}`;
  const issued_at = parsed.issued_at ?? new Date().toISOString();
  const source = ctx.backend.kind === "fixture" ? ("fixture" as const) : undefined;
  return (await ctx.bus.emit({
    name: "receipt_issued",
    payload: {
      request_id: parsed.request_id,
      execution_id,
      tier: "agent_asserted",
      action: parsed.action,
      issued_at,
      payload_sha256,
      ...(source !== undefined ? { source } : {}),
    },
    producer: VEK_PRODUCER,
    correlation_id: ctx.run_id,
  })) as ReceiptIssuedEvent;
}
