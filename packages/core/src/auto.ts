/**
 * C17: when auto flags are true in owner mode, Adapter.start for matching adapters.
 * TODO(cli-integration): call real createAdapter() once adapter packages land.
 */
import type { LatticeagConfig } from "@latticeag/config";
import type { AutoChainOptions } from "./types.js";
import type { LatticeBus } from "./owner-bus.js";

export async function startAutoAdapters(
  auto: Required<AutoChainOptions>,
  _config: LatticeagConfig,
  _bus: LatticeBus,
  _cwd: string,
  _env: NodeJS.ProcessEnv,
  _abort: AbortSignal,
): Promise<Array<() => Promise<void>>> {
  const stops: Array<() => Promise<void>> = [];
  if (
    !auto.verifyOnToolObserved &&
    !auto.approveOnSteer &&
    !auto.approveOnChallenge &&
    !auto.receiptOnApproved
  ) {
    return stops;
  }
  // Adapter packages are absent. Method-level chaining in LatticeAG covers the flags.
  return stops;
}
