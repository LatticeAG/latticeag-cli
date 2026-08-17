import { describe, expect, test } from "vitest";
import { StageDisabledError } from "./errors.js";
import { createFixtureLattice } from "./test-harness.js";

describe("shield", () => {
  test("shield() throws STAGE_DISABLED", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      await expect(lattice.shield({ tool: "write_file" })).rejects.toBeInstanceOf(StageDisabledError);
      try {
        await lattice.shield({ tool: "write_file" });
        expect.fail("expected STAGE_DISABLED");
      } catch (err) {
        expect(err).toBeInstanceOf(StageDisabledError);
        expect((err as StageDisabledError).code).toBe("STAGE_DISABLED");
      }
    } finally {
      await lattice.close();
    }
  });
});
