import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { open as openAsync, stat as statAsync } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { Option } from "commander";
import { JsonlReader, parseJsonlLine } from "@latticeag/bus";
import { loadConfig } from "@latticeag/config";
import type { AnyLatticeEvent } from "@latticeag/events";
import {
  addGlobalOptions,
  readGlobalOpts,
  type GlobalOpts,
} from "../globals.js";
import { fail } from "../json-envelope.js";
import { failConfig } from "../config-fail.js";
import { formatTextEvent, isUnknownLatticeEvent } from "./events-summary.js";

export type EventsFormat = "text" | "json" | "ndjson";

export interface EventsFlags {
  follow: boolean;
  replay?: string;
  fromSeq: number;
  types: string[];
  runId?: string;
  sessionId?: string;
  format: EventsFormat;
  strictNames: boolean;
  noRedact: boolean;
  limit: number;
  json: boolean;
}

function parsePosInt(raw: unknown, fallback: number, flag: string): number {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`invalid ${flag}`);
  }
  return n;
}

export function resolveEventsFormat(
  explicit: string | undefined,
  globalsJson: boolean,
  isTty: boolean,
): EventsFormat {
  if (explicit === "text" || explicit === "json" || explicit === "ndjson") {
    return explicit;
  }
  if (globalsJson) {
    return "json";
  }
  return isTty ? "text" : "ndjson";
}

function matches(event: AnyLatticeEvent, flags: EventsFlags): boolean {
  if (event.seq < flags.fromSeq) {
    return false;
  }
  if (flags.runId && event.run_id !== flags.runId) {
    return false;
  }
  if (flags.sessionId && event.session_id !== flags.sessionId) {
    return false;
  }
  if (flags.types.length > 0 && !flags.types.includes(event.name)) {
    return false;
  }
  return true;
}

function emitEvent(
  event: AnyLatticeEvent,
  format: EventsFormat,
  collected: AnyLatticeEvent[],
): void {
  if (format === "json") {
    collected.push(event);
    return;
  }
  if (format === "ndjson") {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  process.stdout.write(`${formatTextEvent(event)}\n`);
}

async function readExisting(logPath: string): Promise<AnyLatticeEvent[]> {
  if (!existsSync(logPath)) {
    return [];
  }
  const reader = new JsonlReader(logPath);
  const events: AnyLatticeEvent[] = [];
  for await (const event of reader.events()) {
    events.push(event);
  }
  return events;
}

function fileSizeOrZero(filePath: string): number {
  if (!existsSync(filePath)) {
    return 0;
  }
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

async function followLog(
  logPath: string,
  startOffset: number,
  onEvent: (event: AnyLatticeEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let offset = startOffset;
  let buffer = "";
  let fsWatcher: FSWatcher | undefined;
  let closed = false;

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    fsWatcher?.close();
    fsWatcher = undefined;
  };

  signal.addEventListener("abort", close, { once: true });

  const ensureWatch = (): void => {
    if (closed || fsWatcher !== undefined || !existsSync(logPath)) {
      return;
    }
    try {
      fsWatcher = watch(logPath, () => {
        void readNew();
      });
      fsWatcher.on("error", () => {
        fsWatcher?.close();
        fsWatcher = undefined;
      });
    } catch {
      // file may not exist yet
    }
  };

  const readNew = async (): Promise<void> => {
    if (closed) {
      return;
    }
    let size: number;
    try {
      size = (await statAsync(logPath)).size;
    } catch {
      return;
    }
    ensureWatch();
    if (size < offset) {
      offset = 0;
      buffer = "";
    }
    if (size === offset) {
      return;
    }
    const length = size - offset;
    const buf = Buffer.alloc(length);
    const fh = await openAsync(logPath, "r");
    try {
      await fh.read(buf, 0, length, offset);
    } finally {
      await fh.close();
    }
    offset = size;
    buffer += buf.toString("utf8");
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const parsed = parseJsonlLine(part);
      if (parsed.ok === true) {
        onEvent(parsed.event);
      }
    }
  };

  ensureWatch();
  await readNew();
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (closed) {
        clearInterval(interval);
        resolve();
        return;
      }
      void readNew();
    }, 250);
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(interval);
        close();
        resolve();
      },
      { once: true },
    );
  });
}

export async function executeEvents(flags: EventsFlags): Promise<void> {
  if (flags.follow && flags.format === "json") {
    fail("--format json is incompatible with --follow", {
      json: false,
      command: "events",
      code: "USAGE",
    });
  }
  if (flags.noRedact) {
    const tty = process.stdout.isTTY === true;
    if (!tty || process.env.LATTICEAG_ALLOW_UNREDACTED !== "1") {
      fail("--no-redact requires a TTY and LATTICEAG_ALLOW_UNREDACTED=1", {
        json: flags.json,
        command: "events",
        code: "USAGE",
      });
    }
  }

  const cwd = process.cwd();
  let logPath: string;
  if (flags.replay) {
    logPath = path.resolve(cwd, flags.replay);
  } else {
    try {
      const loaded = loadConfig(cwd);
      logPath = path.resolve(
        path.dirname(loaded.path),
        loaded.config.bus.log_path,
      );
    } catch (err) {
      failConfig(err, flags.json, "events");
    }
  }

  const existing = await readExisting(logPath);
  const matched: AnyLatticeEvent[] = [];
  for (const event of existing) {
    if (flags.strictNames && isUnknownLatticeEvent(event)) {
      fail("UnknownLatticeEvent", {
        json: flags.json,
        command: "events",
        code: "STRICT_NAMES",
      });
    }
    if (!matches(event, flags)) {
      continue;
    }
    matched.push(event);
  }

  const collected: AnyLatticeEvent[] = [];
  const take =
    flags.follow || flags.limit === 0 ? matched : matched.slice(0, flags.limit);

  if (!flags.follow && take.length === 0) {
    if (flags.format === "json") {
      process.stdout.write("[]\n");
      return;
    }
    if (!flags.json) {
      process.stderr.write("0 events\n");
    }
    return;
  }

  for (const event of take) {
    emitEvent(event, flags.format, collected);
  }

  if (!flags.follow) {
    if (flags.format === "json") {
      process.stdout.write(`${JSON.stringify(collected)}\n`);
    }
    return;
  }

  const ac = new AbortController();
  const onSigint = (): void => {
    ac.abort();
  };
  process.on("SIGINT", onSigint);

  let live = 0;
  const startOffset = fileSizeOrZero(logPath);
  try {
    await followLog(
      logPath,
      startOffset,
      (event) => {
        if (flags.strictNames && isUnknownLatticeEvent(event)) {
          ac.abort();
          fail("UnknownLatticeEvent", {
            json: flags.json,
            command: "events",
            code: "STRICT_NAMES",
          });
        }
        if (!matches(event, flags)) {
          return;
        }
        if (flags.limit > 0 && live >= flags.limit) {
          ac.abort();
          return;
        }
        live += 1;
        emitEvent(event, flags.format, collected);
        if (flags.limit > 0 && live >= flags.limit) {
          ac.abort();
        }
      },
      ac.signal,
    );
  } finally {
    process.off("SIGINT", onSigint);
  }
  process.exit(0);
}

export function registerEvents(program: Command): void {
  const cmd = program
    .command("events")
    .description("Inspect JSONL.")
    .option("--follow", "Tail after printing existing lines")
    .option("--replay <path>", "Read this file instead of config log_path")
    .option("--from-seq <n>", "Skip lines with seq < n", "1")
    .option(
      "--type <name>",
      "Filter name (repeatable)",
      (value, prev: string[]) => {
        prev.push(value);
        return prev;
      },
      [] as string[],
    )
    .option("--run-id <ulid>", "Filter by run id")
    .option("--session-id <id>", "Filter by session id")
    .addOption(
      new Option("--format <text|json|ndjson>", "text if TTY else ndjson").choices(
        ["text", "json", "ndjson"],
      ),
    )
    .option("--strict-names", "Exit 1 on UnknownLatticeEvent")
    .option("--no-redact", "Requires TTY and LATTICEAG_ALLOW_UNREDACTED=1")
    .option("--limit <n>", "0 means unlimited", "0")
    .action(async (opts: Record<string, unknown>, command: Command) => {
      const globals = readGlobalOpts(command) as GlobalOpts;
      let fromSeq = 1;
      let limit = 0;
      try {
        fromSeq = parsePosInt(opts.fromSeq, 1, "--from-seq");
        limit = parsePosInt(opts.limit, 0, "--limit");
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err), {
          json: globals.json === true,
          command: "events",
          code: "USAGE",
        });
      }
      if (fromSeq < 1) {
        fromSeq = 1;
      }
      const format = resolveEventsFormat(
        opts.format as string | undefined,
        globals.json === true,
        process.stdout.isTTY === true,
      );
      const noRedact = opts.redact === false;
      await executeEvents({
        follow: opts.follow === true,
        replay: opts.replay as string | undefined,
        fromSeq,
        types: Array.isArray(opts.type) ? (opts.type as string[]) : [],
        runId: opts.runId as string | undefined,
        sessionId: opts.sessionId as string | undefined,
        format,
        strictNames: opts.strictNames === true,
        noRedact,
        limit,
        json: globals.json === true,
      });
    });
  addGlobalOptions(cmd);
}
