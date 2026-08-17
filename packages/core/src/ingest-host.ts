/** Optional ingest listen. Does not bind on import. CLI D14 / C13. */
import type { LatticeagConfig } from "@latticeag/config";
import { IngestBindError } from "./errors.js";
import type { LatticeBus } from "./owner-bus.js";

export interface IngestHandle {
  stop(): Promise<void>;
  url: string;
}

export async function startIngestHost(
  config: LatticeagConfig,
  _bus: LatticeBus,
  env: NodeJS.ProcessEnv,
): Promise<IngestHandle> {
  if (env.LATTICEAG_INGEST_EXPOSE === "1") {
    throw new IngestBindError("INGEST_BIND", "LATTICEAG_INGEST_EXPOSE must stay unset in tests");
  }
  // TODO(cli-integration): dynamic import packages/cli/src/ingest.ts when the CLI ingest server lands.
  throw new IngestBindError(
    "INGEST_BIND",
    `ingest host requires @latticeag/cli ingest.ts (not in workspace yet). port ${config.ingest.port}`,
  );
}
