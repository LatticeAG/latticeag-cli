import type { Adapter, AdapterContext } from "@latticeag/bus";
import {
  enabledAdapters,
  parseAdapterList,
  UnknownAdapterError,
  type AdapterName,
  type LatticeagConfig,
} from "@latticeag/config";

export const STARTABLE_ADAPTERS: readonly AdapterName[] = [
  "axion",
  "visreplay",
  "lexverdict",
  "vekinbox",
  "viscompile",
];

export class AdapterOverlayError extends Error {
  readonly code = "ADAPTER_OVERLAY";
  constructor(message: string) {
    super(message);
    this.name = "AdapterOverlayError";
  }
}

export function resolveRunAdapters(
  config: LatticeagConfig,
  overlayList?: string,
): AdapterName[] {
  const enabled = enabledAdapters(config);
  if (overlayList === undefined || overlayList.trim().length === 0) {
    return enabled.filter((name) => STARTABLE_ADAPTERS.includes(name));
  }
  let requested: AdapterName[];
  try {
    requested = parseAdapterList(overlayList);
  } catch (err) {
    if (err instanceof UnknownAdapterError) {
      throw new AdapterOverlayError(`unknown adapter slug: ${err.slug}`);
    }
    throw err;
  }
  for (const name of requested) {
    if (!config.adapters[name].enabled) {
      throw new AdapterOverlayError(
        `--adapters cannot enable ${name} (not enabled in config)`,
      );
    }
  }
  return requested.filter((name) => STARTABLE_ADAPTERS.includes(name));
}

export async function createAdapters(names: AdapterName[]): Promise<Adapter[]> {
  const out: Adapter[] = [];
  for (const name of names) {
    if (name === "axion") {
      const { createAdapter } = await import("@latticeag/adapter-axion");
      out.push(createAdapter());
      continue;
    }
    if (name === "visreplay") {
      const { createAdapter } = await import("@latticeag/adapter-visreplay");
      out.push(createAdapter());
      continue;
    }
    if (name === "lexverdict") {
      const { createAdapter } = await import("@latticeag/adapter-lexverdict");
      out.push(createAdapter());
      continue;
    }
    if (name === "vekinbox") {
      const { createAdapter } = await import("@latticeag/adapter-vekinbox");
      out.push(createAdapter());
      continue;
    }
    if (name === "viscompile") {
      const { createAdapter } = await import("@latticeag/adapter-viscompile");
      out.push(createAdapter());
      continue;
    }
    throw new AdapterOverlayError(`adapter ${name} is not startable in v0.1`);
  }
  return out;
}

export async function startAdapters(
  adapters: Adapter[],
  ctx: AdapterContext,
): Promise<Adapter[]> {
  const started: Adapter[] = [];
  try {
    for (const adapter of adapters) {
      await adapter.start(ctx);
      started.push(adapter);
    }
  } catch (err) {
    for (const adapter of [...started].reverse()) {
      await adapter.stop().catch(() => undefined);
    }
    throw err;
  }
  return started;
}

export async function stopAdapters(adapters: Adapter[]): Promise<void> {
  for (const adapter of [...adapters].reverse()) {
    await adapter.stop().catch(() => undefined);
  }
}
