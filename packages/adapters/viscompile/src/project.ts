import { existsSync, readFileSync } from "node:fs";
import type {
  AdapterErrorEvent,
  AnyLatticeEvent,
  BeliefExtractedEvent,
  JsonValue,
  SessionRecordedEvent,
  ToolObservedEvent,
} from "@latticeag/events";

export type SchemaVersion = 1 | 2;

export interface TranscriptToolCall {
  type: "tool_call";
  name: string;
  arguments: JsonValue;
}

export interface TranscriptBelief {
  type: "belief";
  belief_type: string;
  text: string;
  confidence: number;
  id: string;
  evidence?: string;
}

export interface TranscriptFinal {
  type: "final";
  output: JsonValue;
}

export interface TranscriptError {
  type: "error";
  message: string;
}

export type TranscriptCaseEvent =
  | TranscriptToolCall
  | TranscriptBelief
  | TranscriptFinal
  | TranscriptError;

export interface TranscriptCase {
  id: string;
  input: JsonValue;
  events: TranscriptCaseEvent[];
}

export interface TranscriptDocument {
  kind: "latticeag.viscompile.transcript";
  schema_version: SchemaVersion;
  cases: TranscriptCase[];
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (t === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function asJsonValue(value: unknown): JsonValue {
  if (isJsonValue(value)) {
    return value;
  }
  return String(value);
}

function currentRunId(events: AnyLatticeEvent[]): string | undefined {
  return events[0]?.run_id;
}

function childAdapterError(
  events: AnyLatticeEvent[],
): AdapterErrorEvent | undefined {
  for (const event of events) {
    if (event.name !== "adapter_error") {
      continue;
    }
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      continue;
    }
    const rec = payload as { cause_name?: unknown; message?: unknown };
    const cause = typeof rec.cause_name === "string" ? rec.cause_name : "";
    const message = typeof rec.message === "string" ? rec.message : "";
    if (
      /child|spawn|exec/i.test(cause) ||
      /child|spawn|exec/i.test(message)
    ) {
      return event as AdapterErrorEvent;
    }
  }
  return undefined;
}

function lastVisReplayOutput(events: AnyLatticeEvent[]): JsonValue {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.name !== "session_recorded") {
      continue;
    }
    const recorded = event as SessionRecordedEvent;
    const filePath = recorded.payload.path;
    if (!filePath || !existsSync(filePath)) {
      continue;
    }
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
        events?: Array<{ type?: string; content?: unknown }>;
      };
      if (!Array.isArray(raw.events)) {
        continue;
      }
      for (let j = raw.events.length - 1; j >= 0; j--) {
        const item = raw.events[j];
        if (item?.type === "output" && item.content !== undefined) {
          return asJsonValue(item.content);
        }
      }
    } catch {
      continue;
    }
  }
  return {};
}

/**
 * Project latticeag events onto a viscompile transcript document.
 * Algorithm: SPEC-V0.1-EXTREME.md section 10.4.
 */
export function projectTranscript(
  events: AnyLatticeEvent[],
  caseId: string,
  input: JsonValue,
  schemaVersion: SchemaVersion,
): TranscriptDocument {
  const runId = currentRunId(events);
  const scoped = events
    .filter((event) => (runId === undefined ? true : event.run_id === runId))
    .slice()
    .sort((a, b) => a.seq - b.seq);

  const terminalError = childAdapterError(scoped);
  const terminalSeq = terminalError?.seq;

  const caseEvents: TranscriptCaseEvent[] = [];
  for (const event of scoped) {
    if (event.name === "tool_observed") {
      const payload = (event as ToolObservedEvent).payload;
      caseEvents.push({
        type: "tool_call",
        name: payload.name,
        arguments: payload.arguments,
      });
      continue;
    }
    if (schemaVersion === 2 && event.name === "belief_extracted") {
      if (terminalSeq !== undefined && event.seq > terminalSeq) {
        continue;
      }
      const belief = (event as BeliefExtractedEvent).payload.belief;
      const mapped: TranscriptBelief = {
        type: "belief",
        belief_type: belief.type,
        text: belief.text,
        confidence: belief.confidence,
        id: belief.id,
      };
      if (belief.evidence !== undefined) {
        mapped.evidence = belief.evidence;
      }
      caseEvents.push(mapped);
    }
  }

  if (terminalError) {
    caseEvents.push({
      type: "error",
      message: terminalError.payload.message,
    });
  } else {
    caseEvents.push({
      type: "final",
      output: lastVisReplayOutput(scoped),
    });
  }

  return {
    kind: "latticeag.viscompile.transcript",
    schema_version: schemaVersion,
    cases: [
      {
        id: caseId,
        input,
        events: caseEvents,
      },
    ],
  };
}
