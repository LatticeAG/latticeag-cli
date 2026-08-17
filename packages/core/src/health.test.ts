import { describe, expect, test } from "vitest";
import { createFixtureLattice } from "./test-harness.js";

describe("health", () => {
  test("secrets report chars not value", async () => {
    const secret = "vk_test_secretvalue";
    const { lattice } = await createFixtureLattice({
      env: { VEKINBOX_API_KEY: secret },
    });
    try {
      const report = await lattice.health();
      const vek = report.secrets.find((item) => item.id === "VEKINBOX_API_KEY");
      expect(vek?.presence).toBe("present");
      expect(vek?.chars).toBe(secret.length);
      expect(JSON.stringify(report)).not.toContain(secret);
    } finally {
      await lattice.close();
    }
  });
});
