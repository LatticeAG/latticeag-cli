import { describe, expect, test } from "vitest";
import { createFixtureLattice } from "./test-harness.js";

describe("observeTool", () => {
  test("duplicate visreplay_event_id is a no-op returning the same event id", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const first = await lattice.observeTool({
        source: "visreplay",
        name: "write_file",
        arguments: { path: "a" },
        visreplay_event_id: "vr-dup-1",
      });
      const second = await lattice.observeTool({
        source: "visreplay",
        name: "write_file",
        arguments: { path: "b" },
        visreplay_event_id: "vr-dup-1",
      });
      expect(second.id).toBe(first.id);
      expect(second.seq).toBe(first.seq);
    } finally {
      await lattice.close();
    }
  });
});
