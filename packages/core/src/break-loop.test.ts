import type { ExtensionEvent } from "@latticeag/events";
import { describe, expect, test } from "vitest";
import { StageNotImplementedError } from "./errors.js";
import { breakLoopInputSchema } from "./stages/break-loop.js";
import type { StageHandler } from "./stages/types.js";
import { createFixtureLattice } from "./test-harness.js";
import type { BreakLoopInput } from "./types.js";

const EXTENSION_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

describe("breakLoop", () => {
  test("without handler throws STAGE_NOT_IMPLEMENTED", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      await expect(lattice.breakLoop({ window: [{ name: "write_file" }] })).rejects.toBeInstanceOf(
        StageNotImplementedError,
      );
      try {
        await lattice.breakLoop({ window: [{ name: "write_file" }] });
        expect.fail("expected STAGE_NOT_IMPLEMENTED");
      } catch (err) {
        expect((err as StageNotImplementedError).code).toBe("STAGE_NOT_IMPLEMENTED");
      }
    } finally {
      await lattice.close();
    }
  });

  test("registered handler extension_name matches product.event regex", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const handler: StageHandler<BreakLoopInput, ExtensionEvent> = {
        id: "break_loop",
        product: "latticeag",
        adapter: "@latticeag/adapter-lexloop",
        inputSchema: breakLoopInputSchema,
        async execute(_input, ctx) {
          return (await ctx.bus.emit({
            name: "extension",
            payload: {
              extension_name: "lexloop.loop_detected",
              payload: { window: 1 },
            },
            producer: {
              product: "latticeag",
              adapter: "@latticeag/adapter-lexloop",
              adapter_version: "0.1.0",
            },
            correlation_id: ctx.run_id,
          })) as ExtensionEvent;
        },
        async health() {
          return { id: "break_loop", ok: true, detail: "ok" };
        },
        redactKeys() {
          return [];
        },
      };
      lattice.registerStage(handler);
      const event = await lattice.breakLoop({ window: [{ name: "write_file" }] });
      expect(event.name).toBe("extension");
      expect(event.payload.extension_name).toMatch(EXTENSION_NAME_RE);
      expect(event.payload.extension_name).toBe("lexloop.loop_detected");
    } finally {
      await lattice.close();
    }
  });
});
