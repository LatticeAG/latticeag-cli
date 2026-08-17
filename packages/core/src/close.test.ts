import { describe, expect, test } from "vitest";
import { LatticeAGError } from "./errors.js";
import { createFixtureLattice } from "./test-harness.js";

describe("close", () => {
  test("double close is ok", async () => {
    const { lattice } = await createFixtureLattice();
    await lattice.close();
    await expect(lattice.close()).resolves.toBeUndefined();
  });

  test("inspect after close throws CLOSED", async () => {
    const { lattice } = await createFixtureLattice();
    await lattice.close();
    try {
      await lattice.inspect({ source: "fixture" });
      expect.fail("expected CLOSED");
    } catch (err) {
      expect(err).toBeInstanceOf(LatticeAGError);
      expect((err as LatticeAGError).code).toBe("CLOSED");
    }
  });
});
