import { describe, expect, test } from "vitest";
import { payloadSha256 } from "./stages/receipt.js";
import { createFixtureLattice } from "./test-harness.js";

describe("receipt", () => {
  test("sha256 of empty Uint8Array is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", () => {
    expect(payloadSha256(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("tier is always agent_asserted", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const event = await lattice.receipt({
        request_id: "req_01ARZ3NDEKTSV4RRFFQ69G5FAX",
        action: "write_file",
        payload_bytes: new Uint8Array(),
      });
      expect(event.payload.tier).toBe("agent_asserted");
      expect(event.payload.payload_sha256).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    } finally {
      await lattice.close();
    }
  });
});
