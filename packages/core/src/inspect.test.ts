import { afterEach, describe, expect, test, vi } from "vitest";
import { InspectTextUnsupportedError } from "./errors.js";
import { createFixtureLattice } from "./test-harness.js";

describe("inspect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("fixture source returns N>=1 beliefs sharing causation_id", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const beliefs = await lattice.inspect({ source: "fixture" });
      expect(beliefs.length).toBeGreaterThanOrEqual(1);
      const firstId = beliefs[0]?.id;
      expect(firstId).toBeDefined();
      for (const event of beliefs) {
        expect(event.causation_id).toBe(firstId);
      }
    } finally {
      await lattice.close();
    }
  });

  test("text without LATTICEAG_AXION_EXTRACT_MODULE throws InspectTextUnsupportedError", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      await expect(lattice.inspect({ source: "text", text: "hello" })).rejects.toBeInstanceOf(
        InspectTextUnsupportedError,
      );
    } finally {
      await lattice.close();
    }
  });

  test("session poll maps webhook batch with a new belief id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            spec: "axion.belief_batch.v1",
            sessionId: "ses_session_poll",
            timestamp: 1755439020999,
            provider: "openai",
            modelName: "gpt-4.1-mini",
            callsInSession: 1,
            inboundMessageCount: 1,
            redactions: 0,
            beliefs: [
              {
                id: "22222222-2222-4222-8222-222222222222",
                sessionId: "ses_session_poll",
                type: "assumption",
                belief: "session poll belief",
                confidence: 0.7,
                timestamp: 1755439020999,
                line: 2,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { lattice } = await createFixtureLattice();
    try {
      const beliefs = await lattice.inspect({ source: "session" });
      expect(beliefs.length).toBeGreaterThanOrEqual(1);
      expect(beliefs[0]?.payload.belief.id).toBe("22222222-2222-4222-8222-222222222222");
    } finally {
      await lattice.close();
    }
  });
});
