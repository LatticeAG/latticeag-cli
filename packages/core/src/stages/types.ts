import type { z } from "zod";
import type { AnyLatticeEvent, ProductSlug } from "@latticeag/events";
import type { LatticeagConfig } from "@latticeag/config";
import type { ResolvedBackend, StageId } from "../types.js";
import type { LatticeBus } from "@latticeag/bus";
import type { IngestBus } from "../child-bus.js";

export type { StageId };

export type BusLike = LatticeBus | IngestBus;

export interface AdapterHealth {
  id: string;
  ok: boolean;
  detail: string;
}

export interface StageExecuteContext {
  config: LatticeagConfig;
  bus: BusLike;
  cwd: string;
  env: NodeJS.ProcessEnv;
  abort: AbortSignal;
  run_id: string;
  session_id: string;
  backend: ResolvedBackend;
}

export interface StageHandler<I, O extends AnyLatticeEvent | AnyLatticeEvent[]> {
  id: StageId;
  product: ProductSlug;
  adapter: string;
  inputSchema: z.ZodType<I>;
  execute(input: I, ctx: StageExecuteContext): Promise<O>;
  health(): Promise<AdapterHealth>;
  redactKeys(): string[];
}
