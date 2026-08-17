import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ulid } from "ulid";
import type { VisReplaySessionEvent } from "@latticeag/adapter-visreplay/map";
import { emptyEventCounts } from "./mappers.js";
import type { JsonValue } from "@latticeag/events";

export interface WrapAgentOptions {
  sessionName: string;
  agentType: string;
  sessionId: string;
}

export class VisReplayStub {
  readonly sessionName: string;
  readonly agentType: string;
  readonly sessionId: string;
  readonly startedAt: string;
  events: VisReplaySessionEvent[] = [];
  savedPath?: string;

  constructor(opts: WrapAgentOptions) {
    this.sessionName = opts.sessionName;
    this.agentType = opts.agentType;
    this.sessionId = opts.sessionId;
    this.startedAt = new Date().toISOString();
  }

  getSession(): {
    events: VisReplaySessionEvent[];
    sessionId: string;
    sessionName: string;
    agentType: string;
    startedAt: string;
  } {
    return {
      events: this.events,
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      agentType: this.agentType,
      startedAt: this.startedAt,
    };
  }

  async save(path: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    const body = JSON.stringify({
      visreplay_schema: "visreplay/session/1.0",
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      agentType: this.agentType,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      events: this.events,
    });
    await writeFile(path, body, "utf8");
    this.savedPath = path;
    return path;
  }

  recordTool(name: string, args: Record<string, JsonValue>, result?: JsonValue, error?: string): void {
    this.events.push({
      eventId: ulid(),
      type: "tool_call",
      name,
      arguments: args,
    });
    this.events.push({
      eventId: ulid(),
      type: "tool_result",
      name,
      ...(result !== undefined ? { output: result } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }
}

export function wrapAgent<T extends object>(
  agent: T,
  opts: WrapAgentOptions,
): { agent: T; visReplay: VisReplayStub } {
  const visReplay = new VisReplayStub(opts);
  const counts = emptyEventCounts();
  counts.input = 1;
  void counts;
  return { agent, visReplay };
}
