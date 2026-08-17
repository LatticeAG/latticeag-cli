import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlLog, JsonlReader } from "./jsonl.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "latticeag-jsonl-"));
}

describe("JsonlLog", () => {
  it("append lines", async () => {
    const dir = tempDir();
    const path = join(dir, "events.jsonl");
    const log = new JsonlLog(path, 1_000_000);
    await log.appendEvent({ a: 1 });
    await log.appendEvent({ a: 2 });
    const text = readFileSync(path, "utf8");
    expect(text).toBe('{"a":1}\n{"a":2}\n');
    expect(text.includes("\r")).toBe(false);
  });

  it("rotate when over max_log_bytes", async () => {
    const dir = tempDir();
    const path = join(dir, "events.jsonl");
    const log = new JsonlLog(path, 40);
    const first = await log.appendEvent({ n: 1, pad: "xxxxxxxxxxxxxxxxxxxx" });
    expect(first.rotated).toBe(false);
    expect(existsSync(path)).toBe(true);
    const second = await log.appendEvent({ n: 2, pad: "yyyyyyyyyyyyyyyyyyyy" });
    expect(second.rotated).toBe(true);
    expect(second.bak_path).toBeDefined();
    expect(existsSync(second.bak_path ?? "")).toBe(true);
    expect(existsSync(path)).toBe(false);
    const bak = readFileSync(second.bak_path ?? "", "utf8");
    expect(bak.split("\n").filter((l) => l.length > 0)).toHaveLength(2);
    const baks = readdirSync(dir).filter((name) => name.endsWith(".bak"));
    expect(baks.length).toBe(1);
    expect(baks[0]?.startsWith("events.jsonl.")).toBe(true);
  });

  it("reader skips bad JSON and increments parse_errors", async () => {
    const dir = tempDir();
    const path = join(dir, "events.jsonl");
    const log = new JsonlLog(path, 1_000_000);
    await log.appendLine("{not json\n");
    await log.appendLine("\n");
    const reader = new JsonlReader(path);
    const events = [];
    for await (const event of reader.events()) {
      events.push(event);
    }
    expect(events).toEqual([]);
    expect(reader.parse_errors).toBe(1);
  });
});
