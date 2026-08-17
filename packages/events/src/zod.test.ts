import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { EVENT_NAMES } from "./types.js";
import { latticeEventSchema } from "./zod.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as unknown;
}

describe("latticeEventSchema", () => {
  const files = readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".json") && name !== "vc1013-belief.json")
    .sort();

  test("skips vc1013-belief.json as a non-envelope", () => {
    expect(files).not.toContain("vc1013-belief.json");
  });

  test("covers every EventName", () => {
    for (const name of EVENT_NAMES) {
      expect(files).toContain(`${name}.json`);
    }
  });

  test.each(files)("roundtrip %s", (file) => {
    const raw = loadJson(file);
    const parsed = latticeEventSchema.parse(raw);
    expect(parsed).toEqual(raw);
  });

  test("vc1013-belief.json documents a viscompile belief event", () => {
    const doc = loadJson("vc1013-belief.json") as {
      schema_version: number;
      cases: Array<{ events: Array<{ type: string }> }>;
    };
    expect(doc.schema_version).toBe(2);
    const belief = doc.cases[0]?.events.find((event) => event.type === "belief");
    expect(belief).toMatchObject({
      type: "belief",
      belief_type: "assumption",
      text: "staging shares prod credentials",
      confidence: 0.5,
      id: "belief-assumption-1",
    });
  });
});
