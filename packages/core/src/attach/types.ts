import type { LatticeagConfig } from "@latticeag/config";

export interface AgentAttachKit {
  id: "openai-completions" | "openai-agents" | "hermes" | "langgraph" | "custom";
  detect(env: NodeJS.ProcessEnv, argv: string[]): boolean;
  injectEnv(
    env: NodeJS.ProcessEnv,
    ctx: {
      config: LatticeagConfig;
      run_id: string;
      session_id: string;
      ingest_url: string;
      axion_base_url?: string;
    },
  ): NodeJS.ProcessEnv;
  beforeSpawn?(cwd: string): Promise<void>;
}
