import type { AnyLatticeEvent, EventName, LatticeEvent } from "./types.js";
import {
  EVENT_NAMES,
  EnvelopeTooLargeError,
  EventPayloadError,
  MAX_ENVELOPE_BYTES,
} from "./types.js";
import { envelopeBaseSchema, latticeEventSchema, payloadSchemaByName } from "./zod.js";

export { EnvelopeTooLargeError, EventPayloadError };

const EVENT_NAME_SET: ReadonlySet<string> = new Set(EVENT_NAMES);

function jsonPointerFromPath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) {
    return "/payload";
  }
  const segs = path.map((part) =>
    String(part).replace(/~/g, "~0").replace(/\//g, "~1"),
  );
  return `/payload/${segs.join("/")}`;
}

function assertEnvelopeSize(input: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return;
  }
  if (typeof serialized === "string" && serialized.length > MAX_ENVELOPE_BYTES) {
    throw new EnvelopeTooLargeError(serialized.length);
  }
}

export function parseEnvelope(input: unknown): AnyLatticeEvent {
  assertEnvelopeSize(input);

  const base = envelopeBaseSchema.parse(input);
  if (!EVENT_NAME_SET.has(base.name)) {
    return base;
  }

  const name = base.name as EventName;
  const payloadResult = payloadSchemaByName[name].safeParse(base.payload);
  if (!payloadResult.success) {
    const issue = payloadResult.error.issues[0];
    const pointer = jsonPointerFromPath(issue?.path ?? []);
    const message = issue?.message ?? "invalid payload";
    throw new EventPayloadError(message, pointer);
  }

  return latticeEventSchema.parse(input) as LatticeEvent;
}
