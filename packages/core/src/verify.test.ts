import { describe, expect, test } from "vitest";
import { LatticeAGError } from "./errors.js";
import { createFixtureLattice } from "./test-harness.js";

describe("verify", () => {
  test("first write_file verify is steer, second is pass", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const firstTool = await lattice.observeTool({
        source: "visreplay",
        name: "write_file",
        arguments: { path: "a" },
        result: { ok: true },
      });
      const steer = await lattice.verify({
        causation_id: firstTool.id,
        name: "write_file",
        arguments: firstTool.payload.arguments,
        result: firstTool.payload.result,
      });
      expect(steer.payload.verdict).toBe("steer");
      const secondTool = await lattice.observeTool({
        source: "visreplay",
        name: "write_file",
        arguments: { path: "b" },
        result: { ok: true },
      });
      const pass = await lattice.verify({
        causation_id: secondTool.id,
        name: "write_file",
        arguments: secondTool.payload.arguments,
        result: secondTool.payload.result,
      });
      expect(pass.payload.verdict).toBe("pass");
    } finally {
      await lattice.close();
    }
  });

  test("tool_call of 8001 chars throws VERIFY_FIELD_TOO_LONG", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      await expect(
        lattice.verify({ tool_call: "x".repeat(8001), result: { ok: true } }),
      ).rejects.toMatchObject({ code: "VERIFY_FIELD_TOO_LONG" });
      try {
        await lattice.verify({ tool_call: "x".repeat(8001), result: { ok: true } });
        expect.fail("expected VERIFY_FIELD_TOO_LONG");
      } catch (err) {
        expect(err).toBeInstanceOf(LatticeAGError);
        expect((err as LatticeAGError).code).toBe("VERIFY_FIELD_TOO_LONG");
      }
    } finally {
      await lattice.close();
    }
  });

  test("idempotent causation_id does not consume another fixture row", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const first = await lattice.verify({
        causation_id: "cause-same",
        name: "write_file",
        arguments: { path: "a" },
        result: { ok: true },
      });
      const again = await lattice.verify({
        causation_id: "cause-same",
        name: "write_file",
        arguments: { path: "a" },
        result: { ok: true },
      });
      expect(again.id).toBe(first.id);
      const remaining = await lattice.verify({
        causation_id: "cause-other",
        name: "write_file",
        arguments: { path: "b" },
        result: { ok: true },
      });
      expect(remaining.id).not.toBe(first.id);
      expect(remaining.payload.verdict).not.toBe(first.payload.verdict);
    } finally {
      await lattice.close();
    }
  });
});
