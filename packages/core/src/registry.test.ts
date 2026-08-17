import type { BeliefExtractedEvent } from "@latticeag/events";
import { z } from "zod";
import { describe, expect, test } from "vitest";
import { ConfigError } from "./errors.js";
import { inspectInputSchema } from "./stages/inspect.js";
import type { StageHandler } from "./stages/types.js";
import { createFixtureLattice } from "./test-harness.js";
import type { InspectInput } from "./types.js";

describe("registerStage", () => {
  test("cannot replace inspect (STAGE_LOCKED)", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const handler: StageHandler<InspectInput, BeliefExtractedEvent[]> = {
        id: "inspect",
        product: "axion",
        adapter: "@latticeag/adapter-axion",
        inputSchema: inspectInputSchema,
        async execute() {
          return [];
        },
        async health() {
          return { id: "inspect", ok: true, detail: "ok" };
        },
        redactKeys() {
          return [];
        },
      };
      expect(() => lattice.registerStage(handler)).toThrow(ConfigError);
      try {
        lattice.registerStage(handler);
        expect.fail("expected STAGE_LOCKED");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("STAGE_LOCKED");
      }
    } finally {
      await lattice.close();
    }
  });

  test("third party adapter acme-tools fails CONFIG_INVALID", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const handler: StageHandler<unknown, BeliefExtractedEvent[]> = {
        id: "shield",
        product: "lexshield",
        adapter: "acme-tools",
        inputSchema: z.unknown(),
        async execute() {
          return [];
        },
        async health() {
          return { id: "shield", ok: true, detail: "ok" };
        },
        redactKeys() {
          return [];
        },
      };
      expect(() => lattice.registerStage(handler)).toThrow(ConfigError);
      try {
        lattice.registerStage(handler);
        expect.fail("expected CONFIG_INVALID");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("CONFIG_INVALID");
      }
    } finally {
      await lattice.close();
    }
  });
});
