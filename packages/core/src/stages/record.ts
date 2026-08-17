import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SessionRecordedEvent } from "@latticeag/events";
import { StageDisabledError } from "../errors.js";
import {
  emptyEventCounts,
  toSessionRecordedPayload,
} from "../integration/mappers.js";
import type { VisReplayStub } from "../integration/visreplay.js";
import type { RecordInput } from "../types.js";
import type { StageExecuteContext } from "./types.js";

export const recordInputSchema: z.ZodType<RecordInput> = z
  .object({
    path: z.string().min(1).optional(),
    session_name: z.string().optional(),
  })
  .strict();

const VIS_PRODUCER = {
  product: "visreplay" as const,
  adapter: "@latticeag/adapter-visreplay",
  adapter_version: "0.1.0",
};

export async function executeRecord(
  input: RecordInput,
  ctx: StageExecuteContext,
  visReplay: VisReplayStub | undefined,
): Promise<SessionRecordedEvent> {
  const parsed = recordInputSchema.parse(input);

  if (ctx.backend.kind === "fixture" && visReplay === undefined) {
    const fixturePath = ctx.backend.detail;
    const payload = JSON.parse(await readFile(fixturePath, "utf8")) as SessionRecordedEvent["payload"];
    return (await ctx.bus.emit({
      name: "session_recorded",
      payload,
      producer: VIS_PRODUCER,
      correlation_id: ctx.run_id,
    })) as SessionRecordedEvent;
  }

  if (visReplay === undefined) {
    throw new StageDisabledError("NO_SESSION", "record() requires wrap() first", "record");
  }

  const sessionDir = join(ctx.cwd, ctx.config.adapters.visreplay.session_dir);
  const path = parsed.path ?? join(sessionDir, `${ctx.run_id}.vrs`);
  await visReplay.save(path);
  const session = visReplay.getSession();
  const counts = emptyEventCounts();
  for (const event of session.events) {
    counts[event.type] += 1;
  }
  const payload = toSessionRecordedPayload({
    visreplay_session_id: session.sessionId,
    session_name: parsed.session_name ?? session.sessionName,
    agent_type: session.agentType,
    started_at: session.startedAt,
    ended_at: new Date().toISOString(),
    path,
    event_counts: counts,
  });
  return (await ctx.bus.emit({
    name: "session_recorded",
    payload,
    producer: VIS_PRODUCER,
    correlation_id: ctx.run_id,
  })) as SessionRecordedEvent;
}
