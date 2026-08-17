import type { LatticeagConfig } from "@latticeag/config";
import type { HealthReport, StageId } from "./types.js";
import { resolveBackend, type ResolveBackendContext } from "./resolve-backend.js";
import type { BusLike } from "./stages/types.js";

const SECRET_IDS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AXION_READ_TOKEN",
  "AXION_WEBHOOK_SECRET",
  "VEKINBOX_API_KEY",
  "LEXGATEWAY_TOKEN",
  "POLYMESH_API_KEY",
] as const;

const STAGE_IDS: StageId[] = [
  "inspect",
  "shield",
  "verify",
  "record",
  "approve",
  "receipt",
  "compensate",
  "break_loop",
];

function adapterEnabled(id: StageId, config: LatticeagConfig): boolean {
  if (id === "inspect") return config.adapters.axion.enabled;
  if (id === "verify") return config.adapters.lexverdict.enabled;
  if (id === "record") return config.adapters.visreplay.enabled;
  if (id === "approve" || id === "receipt") return config.adapters.vekinbox.enabled;
  if (id === "shield") return config.adapters.lexshield.enabled;
  return false;
}

export async function buildHealth(input: {
  mode: "owner" | "child";
  run_id: string;
  session_id: string;
  bus: BusLike;
  log_path: string;
  config: LatticeagConfig;
  env: NodeJS.ProcessEnv;
  resolveCtx: ResolveBackendContext;
}): Promise<HealthReport> {
  const stages: HealthReport["stages"] = [];
  let ok = true;
  for (const id of STAGE_IDS) {
    const enabled = adapterEnabled(id, input.config) || input.resolveCtx.registered.has(id);
    let backend;
    let health;
    if (enabled) {
      try {
        backend = await resolveBackend(id, input.resolveCtx);
        health = { ok: true, detail: backend.detail };
      } catch (err) {
        ok = false;
        health = {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
    stages.push({ id, enabled, ...(backend !== undefined ? { backend } : {}), ...(health !== undefined ? { health } : {}) });
  }

  const secrets = SECRET_IDS.map((id) => {
    const value = input.env[id];
    if (value === undefined || value.length === 0) {
      return { id, presence: "absent" as const };
    }
    return { id, presence: "present" as const, chars: value.length };
  });

  return {
    ok,
    mode: input.mode,
    run_id: input.run_id,
    session_id: input.session_id,
    bus: { seq: input.bus.seq(), log_path: input.log_path },
    sync: { owner: "cli", enabled: input.config.sync.enabled },
    stages,
    secrets,
  };
}
