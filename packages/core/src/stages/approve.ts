import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  AnyLatticeEvent,
  ApprovalGrantedEvent,
  ExtensionEvent,
  PolicyDecisionEvent,
  VerdictEvent,
} from "@latticeag/events";
import { ApprovalRejectedError, LatticeAGError } from "../errors.js";
import { idempotencyKey } from "../integration/mappers.js";
import type { ApproveInput } from "../types.js";
import type { StageExecuteContext } from "./types.js";

export const approveInputSchema: z.ZodType<ApproveInput> = z
  .object({
    causation_id: z.string().min(1),
    source: z.enum(["verdict", "policy_decision", "manual"]),
    title: z.string().optional(),
    description: z.string().optional(),
    timeout: z.string().regex(/^\d+[smhd]$/).optional(),
    key: z.string().optional(),
  })
  .strict();

const VEK_PRODUCER = {
  product: "vekinbox" as const,
  adapter: "@latticeag/adapter-vekinbox",
  adapter_version: "0.1.0",
};

export interface FixtureApproval {
  key: string;
  request_id: string;
  status: string;
  title: string;
  action: string;
  workspace_id: string;
  agent_id: string;
  resolved_at: string;
  resolved_by?: string;
  priority: "low" | "normal" | "high" | "critical";
  note?: string;
}

export function shouldAutoApprove(env: NodeJS.ProcessEnv): boolean {
  if (env.VEKINBOX_AUTO_APPROVE !== "1") {
    return false;
  }
  const key = env.VEKINBOX_API_KEY ?? "";
  if (key.startsWith("vk_live_")) {
    return false;
  }
  return key.startsWith("vk_test_");
}

export async function loadApprovalFixtures(path: string): Promise<FixtureApproval[]> {
  return JSON.parse(await readFile(path, "utf8")) as FixtureApproval[];
}

export async function executeApprove(
  input: ApproveInput,
  ctx: StageExecuteContext,
  eventsById: Map<string, AnyLatticeEvent>,
  fixtures: FixtureApproval[],
): Promise<ApprovalGrantedEvent> {
  const parsed = approveInputSchema.parse(input);
  if (parsed.source === "verdict") {
    const event = eventsById.get(parsed.causation_id);
    if (!event || event.name !== "verdict") {
      throw new LatticeAGError("STAGE_BACKEND", "approve source verdict not found");
    }
    if ((event as VerdictEvent).payload.verdict !== "steer") {
      throw new LatticeAGError("STAGE_BACKEND", "approve requires payload.verdict === steer");
    }
  }
  if (parsed.source === "policy_decision") {
    const event = eventsById.get(parsed.causation_id);
    if (!event || event.name !== "policy_decision") {
      throw new LatticeAGError("STAGE_BACKEND", "approve source policy_decision not found");
    }
    if ((event as PolicyDecisionEvent).payload.decision !== "CHALLENGE") {
      throw new LatticeAGError("STAGE_BACKEND", "approve requires decision === CHALLENGE");
    }
  }

  const key = parsed.key ?? idempotencyKey(ctx.run_id, parsed.causation_id);

  if (ctx.backend.kind === "fixture") {
    const rewritten = fixtures.map((row) => ({
      ...row,
      key: row.key === "RUN.CAUSE" ? key : row.key,
    }));
    const row = rewritten.find((item) => item.key === key) ?? rewritten[0];
    if (!row) {
      throw new LatticeAGError("STAGE_BACKEND", "no approval fixture rows");
    }
    if (row.status !== "approved") {
      await ctx.bus.emit({
        name: "extension",
        payload: {
          extension_name: "vekinbox.approval_resolved",
          payload: {
            status: row.status,
            request_id: row.request_id,
            key: row.key,
          },
        },
        producer: VEK_PRODUCER,
        correlation_id: ctx.run_id,
        causation_id: parsed.causation_id,
      });
      throw new ApprovalRejectedError("APPROVAL_REJECTED", `approval ${row.status}`, row.status);
    }
    return (await ctx.bus.emit({
      name: "approval_granted",
      payload: {
        request_id: row.request_id,
        key: row.key,
        title: parsed.title ?? row.title,
        workspace_id: row.workspace_id,
        agent_id: row.agent_id,
        status: "approved",
        action: row.action,
        ...(row.resolved_by !== undefined ? { resolved_by: row.resolved_by } : {}),
        resolved_at: row.resolved_at,
        ...(row.note !== undefined ? { note: row.note } : {}),
        priority: row.priority,
      },
      producer: VEK_PRODUCER,
      correlation_id: ctx.run_id,
      causation_id: parsed.causation_id,
    })) as ApprovalGrantedEvent;
  }

  if (shouldAutoApprove(ctx.env)) {
    const now = new Date().toISOString();
    return (await ctx.bus.emit({
      name: "approval_granted",
      payload: {
        request_id: `req_${ctx.run_id.slice(0, 16)}`,
        key,
        title: parsed.title ?? `Approve after ${parsed.source}`,
        workspace_id: ctx.env.VEKINBOX_WORKSPACE_ID ?? "ws_unknown",
        agent_id: ctx.env.VEKINBOX_AGENT_ID ?? "agt_unknown",
        status: "approved",
        action: parsed.title ?? "approve",
        resolved_by: "auto-approve-test",
        resolved_at: now,
        priority: "normal",
      },
      producer: VEK_PRODUCER,
      correlation_id: ctx.run_id,
      causation_id: parsed.causation_id,
    })) as ApprovalGrantedEvent;
  }

  throw new LatticeAGError(
    "STAGE_BACKEND",
    "live VekInbox approve requires @latticeag/adapter-vekinbox (TODO cli-integration)",
  );
}

export type { ExtensionEvent };
