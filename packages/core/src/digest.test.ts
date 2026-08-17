import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_NAMES } from "@latticeag/events";
import { describe, expect, test } from "vitest";
import { digest } from "./digest.js";
import { DigestError } from "./errors.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../events/fixtures",
);

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as unknown;
}

function envelopeFixtures(): string[] {
  return readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".json") && name !== "vc1013-belief.json")
    .sort();
}

describe("digest", () => {
  test("has one fixture per EventName", () => {
    for (const name of EVENT_NAMES) {
      expect(envelopeFixtures()).toContain(`${name}.json`);
    }
  });

  test.each(envelopeFixtures())("digest(object) ok for %s", (file) => {
    const raw = loadJson(file) as { name: string };
    const result = digest(raw);
    expect(result.ok).toBe(true);
    expect(result.schema).toBe("latticeag.events/1.0");
    expect(result.schema_version).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.name).toBe(raw.name);
    expect(result.parse_errors).toBe(0);
    expect(result.errors).toEqual([]);
  });

  test("unknown name acme.foo is ok with unknown_names", () => {
    const raw = loadJson("belief_extracted.json") as Record<string, unknown>;
    const unknown = { ...raw, name: "acme.foo" };
    const result = digest(unknown);
    expect(result.ok).toBe(true);
    expect(result.unknown_names).toEqual(["acme.foo"]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.name).toBe("acme.foo");
  });

  test("strictNames true returns ok false without throwing", () => {
    const raw = loadJson("belief_extracted.json") as Record<string, unknown>;
    const unknown = { ...raw, name: "acme.foo" };
    const result = digest(unknown, { strictNames: true });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toMatch(/unknown event name/);
    expect(result.unknown_names).toEqual(["acme.foo"]);
  });

  test("strict && strictNames throws DigestError", () => {
    const raw = loadJson("belief_extracted.json") as Record<string, unknown>;
    const unknown = { ...raw, name: "acme.foo" };
    expect(() => digest(unknown, { strict: true, strictNames: true })).toThrow(
      DigestError,
    );
    try {
      digest(unknown, { strict: true, strictNames: true });
    } catch (err) {
      expect(err).toBeInstanceOf(DigestError);
      expect((err as DigestError).code).toBe("DIGEST_STRICT");
      expect((err as DigestError).result.ok).toBe(false);
      expect((err as DigestError).result.unknown_names).toEqual(["acme.foo"]);
    }
  });

  test("bad payload pointer starts with /payload", () => {
    const raw = loadJson("verdict.json") as {
      payload: { verdict: string };
    };
    const bad = structuredClone(raw);
    bad.payload.verdict = "nope";
    const result = digest(bad);
    expect(result.ok).toBe(false);
    expect(result.events).toHaveLength(0);
    expect(result.errors[0]?.pointer.startsWith("/payload")).toBe(true);
  });

  test("strict true on bad payload throws DigestError", () => {
    const raw = loadJson("verdict.json") as {
      payload: { verdict: string };
    };
    const bad = structuredClone(raw);
    bad.payload.verdict = "nope";
    expect(() => digest(bad, { strict: true })).toThrow(DigestError);
    try {
      digest(bad, { strict: true });
    } catch (err) {
      expect(err).toBeInstanceOf(DigestError);
      expect((err as DigestError).code).toBe("DIGEST_STRICT");
      expect((err as DigestError).result.ok).toBe(false);
    }
  });

  test("oversized envelope reports envelope too large", () => {
    const raw = loadJson("belief_extracted.json") as {
      payload: { belief: { text: string } };
    };
    const huge = structuredClone(raw);
    huge.payload.belief.text = "x".repeat(300000);
    expect(JSON.stringify(huge).length).toBeGreaterThan(262144);
    const result = digest(huge);
    expect(result.ok).toBe(false);
    expect(result.events).toHaveLength(0);
    expect(result.errors[0]?.message).toMatch(/envelope too large/);
  });

  test("JSONL two valid lines plus blank plus garbage", () => {
    const a = loadJson("belief_extracted.json");
    const b = loadJson("verdict.json");
    const jsonl = `${JSON.stringify(a)}\n${JSON.stringify(b)}\n\nnot-json\n`;
    const result = digest(jsonl);
    expect(result.parse_errors).toBe(1);
    expect(result.events).toHaveLength(2);
    expect(result.ok).toBe(false);
  });

  test("empty string and whitespace only yield zero events", () => {
    for (const input of ["", "   ", "\n\n", " \t \n "]) {
      const result = digest(input);
      expect(result.events).toHaveLength(0);
      expect(result.ok).toBe(true);
      expect(result.parse_errors).toBe(0);
      expect(result.errors).toEqual([]);
    }
  });
});
