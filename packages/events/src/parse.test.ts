import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { EVENT_NAMES } from "./types.js";
import { parseEnvelope } from "./parse.js";
import { EnvelopeTooLargeError, EventPayloadError } from "./types.js";
import { latticeEventSchema } from "./zod.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as unknown;
}

function envelopeFixtures(): string[] {
  return readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".json") && name !== "vc1013-belief.json")
    .sort();
}

describe("parseEnvelope", () => {
  test("has one fixture per EventName", () => {
    for (const name of EVENT_NAMES) {
      expect(envelopeFixtures()).toContain(`${name}.json`);
    }
  });

  test.each(envelopeFixtures())("roundtrip %s", (file) => {
    const raw = loadJson(file);
    const parsed = parseEnvelope(raw);
    expect(parsed).toEqual(raw);
    expect(latticeEventSchema.parse(raw)).toEqual(raw);
  });

  test("unknown name parses as UnknownLatticeEvent", () => {
    const raw = loadJson("belief_extracted.json") as Record<string, unknown>;
    const unknown = { ...raw, name: "not_a_real_event" };
    const parsed = parseEnvelope(unknown);
    expect(parsed.name).toBe("not_a_real_event");
    expect(parsed.payload).toEqual(raw.payload);
  });

  test("EnvelopeTooLargeError when JSON.stringify exceeds 262144", () => {
    const raw = loadJson("belief_extracted.json") as {
      payload: { belief: { text: string } };
    };
    const huge = structuredClone(raw);
    huge.payload.belief.text = "x".repeat(300000);
    expect(() => parseEnvelope(huge)).toThrow(EnvelopeTooLargeError);
    try {
      parseEnvelope(huge);
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeTooLargeError);
      expect((err as EnvelopeTooLargeError).bytes).toBeGreaterThan(262144);
    }
  });

  test("EventPayloadError on bad payload for a known name", () => {
    const raw = loadJson("belief_extracted.json") as {
      payload: { belief: { confidence: number } };
    };
    const bad = structuredClone(raw);
    bad.payload.belief.confidence = 2;
    expect(() => parseEnvelope(bad)).toThrow(EventPayloadError);
    try {
      parseEnvelope(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(EventPayloadError);
      expect((err as EventPayloadError).pointer).toBe("/payload/belief/confidence");
    }
  });

  test("non-Z timestamp fails", () => {
    const raw = loadJson("belief_extracted.json") as { ts: string };
    const bad = { ...raw, ts: "2026-08-17T13:57:00.123+00:00" };
    expect(() => parseEnvelope(bad)).toThrow();
    expect(() => parseEnvelope(bad)).not.toThrow(EnvelopeTooLargeError);
    expect(() => parseEnvelope(bad)).not.toThrow(EventPayloadError);
  });
});
