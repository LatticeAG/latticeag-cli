import type { CompensationExecutedEvent } from "@latticeag/events";
import { describe, expect, test } from "vitest";
import { StageNotImplementedError } from "./errors.js";
import { compensateInputSchema } from "./stages/compensate.js";
import type { StageHandler } from "./stages/types.js";
import { createFixtureLattice } from "./test-harness.js";
import type { CompensateInput } from "./types.js";

describe("compensate", () => {
  test("without handler throws STAGE_NOT_IMPLEMENTED", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      await expect(
        lattice.compensate({
          request_id: "req-1",
          execution_id: "exec-1",
          action: "revert_write_file",
          state_to: "executed",
        }),
      ).rejects.toBeInstanceOf(StageNotImplementedError);
      try {
        await lattice.compensate({
          request_id: "req-1",
          execution_id: "exec-1",
          action: "revert_write_file",
          state_to: "executed",
        });
        expect.fail("expected STAGE_NOT_IMPLEMENTED");
      } catch (err) {
        expect((err as StageNotImplementedError).code).toBe("STAGE_NOT_IMPLEMENTED");
      }
    } finally {
      await lattice.close();
    }
  });

  test("registered handler emits compensation_executed with state_from compensation_required", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const handler: StageHandler<CompensateInput, CompensationExecutedEvent> = {
        id: "compensate",
        product: "vekinbox",
        adapter: "@latticeag/adapter-vekrevert",
        inputSchema: compensateInputSchema,
        async execute(input, ctx) {
          return (await ctx.bus.emit({
            name: "compensation_executed",
            payload: {
              request_id: input.request_id,
              execution_id: input.execution_id,
              state_from: "compensation_required",
              state_to: input.state_to,
              action: input.action,
            },
            producer: {
              product: "vekinbox",
              adapter: "@latticeag/adapter-vekrevert",
              adapter_version: "0.1.0",
            },
            correlation_id: ctx.run_id,
          })) as CompensationExecutedEvent;
        },
        async health() {
          return { id: "compensate", ok: true, detail: "ok" };
        },
        redactKeys() {
          return [];
        },
      };
      lattice.registerStage(handler);
      const event = await lattice.compensate({
        request_id: "req-approval-1",
        execution_id: "exec-1",
        action: "revert_write_file",
        state_to: "executed",
      });
      expect(event.name).toBe("compensation_executed");
      expect(event.payload.state_from).toBe("compensation_required");
    } finally {
      await lattice.close();
    }
  });
});
