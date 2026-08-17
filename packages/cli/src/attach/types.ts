import type { LatticeagConfig } from "@latticeag/config";

export type AttachKitId =
  | "openai-completions"
  | "openai-agents"
  | "hermes"
  | "langgraph"
  | "custom";

export interface AttachInjectCtx {
  config: LatticeagConfig;
  run_id: string;
  session_id: string;
  ingest_url: string;
  axion_base_url?: string;
}

export interface AgentAttachKit {
  id: AttachKitId;
  detect(env: NodeJS.ProcessEnv, argv: string[]): boolean;
  injectEnv(env: NodeJS.ProcessEnv, ctx: AttachInjectCtx): NodeJS.ProcessEnv;
  beforeSpawn?(cwd: string): Promise<void>;
}

export function injectAxionBaseUrls(
  env: NodeJS.ProcessEnv,
  ctx: AttachInjectCtx,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  if (ctx.axion_base_url) {
    const base = ctx.axion_base_url.replace(/\/$/, "");
    next.OPENAI_BASE_URL = `${base}/v1`;
    next.ANTHROPIC_BASE_URL = base;
  }
  return next;
}
