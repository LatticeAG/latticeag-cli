import { createReadStream } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { parseEnvelope, type AnyLatticeEvent } from "@latticeag/events";

export const DEFAULT_MAX_LOG_BYTES = 268435456;

export interface AppendResult {
  rotated: boolean;
  bak_path?: string;
}

export interface JsonlReadMeta {
  parse_errors: number;
}

export type ParsedJsonlLine =
  | { ok: true; event: AnyLatticeEvent }
  | { ok: false }
  | { ok: "empty" };

export function parseJsonlLine(line: string): ParsedJsonlLine {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (trimmed.length === 0) {
    return { ok: "empty" };
  }
  try {
    const json: unknown = JSON.parse(trimmed);
    const event = parseEnvelope(json);
    return { ok: true, event };
  } catch {
    return { ok: false };
  }
}

export class JsonlLog {
  readonly path: string;
  readonly max_log_bytes: number;

  constructor(path: string, max_log_bytes: number = DEFAULT_MAX_LOG_BYTES) {
    this.path = path;
    this.max_log_bytes = max_log_bytes;
  }

  async appendEvent(event: unknown): Promise<AppendResult> {
    const line = `${JSON.stringify(event)}\n`;
    return this.appendLine(line);
  }

  async appendLine(line: string): Promise<AppendResult> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, line, "utf8");
    const size = await this.size();
    if (size > this.max_log_bytes) {
      const bak_path = `${this.path}.${new Date().toISOString()}.bak`;
      await rename(this.path, bak_path);
      return { rotated: true, bak_path };
    }
    return { rotated: false };
  }

  async size(): Promise<number> {
    try {
      return (await stat(this.path)).size;
    } catch {
      return 0;
    }
  }

  async flush(): Promise<void> {
    return;
  }
}

export class JsonlReader {
  readonly path: string;
  parse_errors = 0;

  constructor(path: string) {
    this.path = path;
  }

  async *events(): AsyncIterable<AnyLatticeEvent> {
    const stream = createReadStream(this.path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const parsed = parseJsonlLine(line);
        if (parsed.ok === "empty") {
          continue;
        }
        if (parsed.ok === false) {
          this.parse_errors += 1;
          continue;
        }
        yield parsed.event;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }
}

export function createJsonlReadMeta(): JsonlReadMeta {
  return { parse_errors: 0 };
}

export async function* readJsonl(
  path: string,
  meta: JsonlReadMeta = createJsonlReadMeta(),
): AsyncIterable<AnyLatticeEvent> {
  const reader = new JsonlReader(path);
  try {
    for await (const event of reader.events()) {
      yield event;
    }
  } finally {
    meta.parse_errors = reader.parse_errors;
  }
}
