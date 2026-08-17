/**
 * VisReplay mapping helpers: session events to lattice partials.
 */
import type {
  JsonObject,
  JsonValue,
  SessionRecordedPayload,
  VisReplayEventType,
} from "@latticeag/events";

export interface VisReplaySessionEvent {
  eventId: string;
  type: VisReplayEventType;
  name?: string;
  arguments?: JsonObject;
  output?: JsonValue;
  error?: string;
}

export function diffSessionEvents(
  seen: Set<string>,
  events: VisReplaySessionEvent[],
): VisReplaySessionEvent[] {
  const fresh: VisReplaySessionEvent[] = [];
  for (const event of events) {
    if (seen.has(event.eventId)) {
      continue;
    }
    seen.add(event.eventId);
    if (event.type === "tool_call" || event.type === "tool_result") {
      fresh.push(event);
    }
  }
  return fresh;
}

export function toSessionRecordedPayload(input: {
  visreplay_session_id: string;
  session_name: string;
  agent_type: string;
  started_at: string;
  ended_at?: string;
  path: string;
  event_counts: Record<VisReplayEventType, number>;
}): SessionRecordedPayload {
  const event_count = Object.values(input.event_counts).reduce((sum, n) => sum + n, 0);
  return {
    visreplay_schema: "visreplay/session/1.0",
    visreplay_session_id: input.visreplay_session_id,
    session_name: input.session_name,
    agent_type: input.agent_type,
    started_at: input.started_at,
    ...(input.ended_at !== undefined ? { ended_at: input.ended_at } : {}),
    path: input.path,
    event_count,
    event_counts: input.event_counts,
  };
}

export function emptyEventCounts(): Record<VisReplayEventType, number> {
  return {
    input: 0,
    reasoning: 0,
    tool_call: 0,
    tool_result: 0,
    output: 0,
    error: 0,
  };
}
