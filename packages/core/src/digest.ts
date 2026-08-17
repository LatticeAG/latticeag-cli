import {
  EVENT_NAMES,
  EnvelopeTooLargeError,
  EventPayloadError,
  MAX_ENVELOPE_BYTES,
  parseEnvelope,
} from "@latticeag/events";
import type { AnyLatticeEvent } from "@latticeag/events";
import { ZodError } from "zod";
import { DigestError } from "./errors.js";
import type { DigestItemError, DigestOptions, DigestResult } from "./types.js";

const KNOWN_NAMES: ReadonlySet<string> = new Set(EVENT_NAMES);

type WorkItem =
  | { kind: "value"; index: number; value: unknown }
  | { kind: "parseError"; index: number };

function jsonPointerFromPath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) {
    return "/";
  }
  const segs = path.map((part) =>
    String(part).replace(/~/g, "~0").replace(/\//g, "~1"),
  );
  return `/${segs.join("/")}`;
}

function pointerFromUnknown(err: unknown): string {
  if (err instanceof EventPayloadError) {
    return err.pointer;
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    if (issue === undefined) {
      return "/";
    }
    return jsonPointerFromPath(issue.path);
  }
  return "/";
}

function messageFromUnknown(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.length > 0) {
    return err.message;
  }
  return fallback;
}

function envelopeTooLarge(value: unknown): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  return typeof serialized === "string" && serialized.length > MAX_ENVELOPE_BYTES;
}

function toWorkItems(input: unknown): WorkItem[] {
  if (input instanceof Uint8Array) {
    return toWorkItems(new TextDecoder("utf-8").decode(input));
  }
  if (typeof input === "string") {
    if (input.trim() === "") {
      return [];
    }
    if (input.includes("\n")) {
      const items: WorkItem[] = [];
      const lines = input.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined || line.trim() === "") {
          continue;
        }
        try {
          items.push({ kind: "value", index, value: JSON.parse(line) as unknown });
        } catch {
          items.push({ kind: "parseError", index });
        }
      }
      return items;
    }
    try {
      return [{ kind: "value", index: 0, value: JSON.parse(input) as unknown }];
    } catch {
      return [{ kind: "parseError", index: 0 }];
    }
  }
  if (Array.isArray(input)) {
    return input.map((value, index) => ({ kind: "value", index, value }));
  }
  return [{ kind: "value", index: 0, value: input }];
}

function finish(args: {
  events: AnyLatticeEvent[];
  unknown_names: string[];
  parse_errors: number;
  errors: DigestItemError[];
}): DigestResult {
  return {
    schema: "latticeag.events/1.0",
    schema_version: 1,
    ok: args.errors.length === 0 && args.parse_errors === 0,
    events: args.events,
    unknown_names: args.unknown_names,
    parse_errors: args.parse_errors,
    errors: args.errors,
  };
}

function throwIfStrict(
  opts: DigestOptions,
  result: DigestResult,
  cause?: unknown,
): void {
  if (opts.strict === true) {
    const first = result.errors[0];
    throw new DigestError(first?.message ?? "digest strict failure", result, {
      cause,
    });
  }
}

export function digest(input: unknown, opts: DigestOptions = {}): DigestResult {
  const events: AnyLatticeEvent[] = [];
  const unknown_names: string[] = [];
  const errors: DigestItemError[] = [];
  let parse_errors = 0;

  const items = toWorkItems(input);
  for (const item of items) {
    if (item.kind === "parseError") {
      parse_errors += 1;
      const result = finish({ events, unknown_names, parse_errors, errors });
      if (opts.strict === true) {
        throw new DigestError("invalid JSON", result);
      }
      continue;
    }

    if (envelopeTooLarge(item.value)) {
      errors.push({
        index: item.index,
        pointer: "/",
        message: "envelope too large",
      });
      const result = finish({ events, unknown_names, parse_errors, errors });
      throwIfStrict(opts, result);
      continue;
    }

    let parsed: AnyLatticeEvent;
    try {
      parsed = parseEnvelope(item.value);
    } catch (err) {
      if (err instanceof EnvelopeTooLargeError) {
        errors.push({
          index: item.index,
          pointer: "/",
          message: "envelope too large",
        });
      } else if (err instanceof EventPayloadError) {
        errors.push({
          index: item.index,
          pointer: err.pointer,
          message: err.message,
        });
      } else {
        errors.push({
          index: item.index,
          pointer: pointerFromUnknown(err),
          message: messageFromUnknown(err, "invalid envelope"),
        });
      }
      const result = finish({ events, unknown_names, parse_errors, errors });
      throwIfStrict(opts, result, err);
      continue;
    }

    if (!KNOWN_NAMES.has(parsed.name)) {
      if (!unknown_names.includes(parsed.name)) {
        unknown_names.push(parsed.name);
      }
      events.push(parsed);
      if (opts.strictNames === true) {
        errors.push({
          index: item.index,
          pointer: "/name",
          message: "unknown event name",
        });
        const result = finish({ events, unknown_names, parse_errors, errors });
        if (opts.strict === true) {
          throw new DigestError("unknown event name", result);
        }
      }
      continue;
    }

    events.push(parsed);
  }

  return finish({ events, unknown_names, parse_errors, errors });
}
