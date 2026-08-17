import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { AnyLatticeEvent } from "@latticeag/events";
import { parseJsonlLine } from "./jsonl.js";

export type JsonlWatchHandler = (event: AnyLatticeEvent) => void;

export interface JsonlWatcher {
  close(): void;
  readonly parse_errors: number;
}

const POLL_MS = 250;

export function createJsonlWatcher(
  path: string,
  onEvent: JsonlWatchHandler,
): JsonlWatcher {
  let offset = 0;
  let buffer = "";
  let parse_errors = 0;
  let closed = false;
  let fsWatcher: FSWatcher | undefined;
  let reading = false;
  let queued = false;

  function ensureFsWatch(): void {
    if (closed || fsWatcher !== undefined) {
      return;
    }
    try {
      fsWatcher = watch(path, () => {
        void readNew();
      });
      fsWatcher.on("error", () => {
        fsWatcher?.close();
        fsWatcher = undefined;
      });
    } catch {
      // File may not exist yet. The poll interval retries.
    }
  }

  async function readNew(): Promise<void> {
    if (closed) {
      return;
    }
    if (reading) {
      queued = true;
      return;
    }
    reading = true;
    try {
      do {
        queued = false;
        if (closed) {
          return;
        }
        let size: number;
        try {
          size = (await stat(path)).size;
        } catch {
          continue;
        }
        ensureFsWatch();
        if (size < offset) {
          offset = 0;
          buffer = "";
        }
        if (size === offset) {
          continue;
        }
        const length = size - offset;
        const buf = Buffer.alloc(length);
        const fh = await open(path, "r");
        try {
          await fh.read(buf, 0, length, offset);
        } finally {
          await fh.close();
        }
        if (closed) {
          return;
        }
        offset = size;
        buffer += buf.toString("utf8");
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const parsed = parseJsonlLine(part);
          if (parsed.ok === "empty") {
            continue;
          }
          if (parsed.ok === false) {
            parse_errors += 1;
            continue;
          }
          onEvent(parsed.event);
        }
      } while (queued && !closed);
    } finally {
      reading = false;
    }
  }

  ensureFsWatch();
  void readNew();
  const interval = setInterval(() => {
    void readNew();
  }, POLL_MS);

  return {
    get parse_errors() {
      return parse_errors;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(interval);
      fsWatcher?.close();
      fsWatcher = undefined;
    },
  };
}
