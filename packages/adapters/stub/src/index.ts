import type { Adapter, AdapterContext, AdapterHealth } from "@latticeag/bus";

export function createAdapter(): Adapter {
  return {
    id: "stub",
    product: "latticeag",
    async start(_ctx: AdapterContext): Promise<void> {
      return;
    },
    async health(): Promise<AdapterHealth> {
      return { id: "stub", ok: true, detail: "stub" };
    },
    async stop(): Promise<void> {
      return;
    },
    redactKeys(): string[] {
      return [];
    },
  };
}
