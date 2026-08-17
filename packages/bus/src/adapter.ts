import type { IncomingMessage, ServerResponse } from "node:http";
import type { LatticeagConfig } from "@latticeag/config";
import type { ProductSlug } from "@latticeag/events";
import type { LatticeBus } from "./bus.js";

export interface AdapterContext {
  config: LatticeagConfig;
  bus: LatticeBus;
  cwd: string;
  env: NodeJS.ProcessEnv;
  abort: AbortSignal;
  registerIngest(
    path: string,
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
      body: unknown,
    ) => Promise<void> | void,
  ): void;
}

export interface AdapterHealth {
  id: string;
  ok: boolean;
  detail: string;
}

export interface Adapter {
  id: string;
  product: ProductSlug;
  start(ctx: AdapterContext): Promise<void>;
  health(): Promise<AdapterHealth>;
  stop(): Promise<void>;
  redactKeys(): string[];
}
