/**
 * VekInbox mapping helpers: approval request lifecycle.
 */
export function idempotencyKey(run_id: string, causation_id: string): string {
  return `${run_id}.${causation_id}`;
}

export interface ApprovedRequest {
  request_id: string;
  key: string;
  title: string;
  workspace_id: string;
  agent_id: string;
  status: "approved";
  action: string;
  resolved_by?: string;
  resolved_at: string;
  note?: string;
  priority: "low" | "normal" | "high" | "critical";
}

export function fromApprovedRequest(row: ApprovedRequest): ApprovedRequest {
  return row;
}

export function toCreateRequestInput(input: {
  workspaceId: string;
  agentId: string;
  key: string;
  title: string;
  description: string;
  timeout: string;
  resumeWebhook?: string;
}): typeof input {
  return input;
}
