import type { AnyLatticeEvent } from "@latticeag/events";
import type { LatticeAG } from "./lattice.js";
import type { PipelineStep, StageId } from "./types.js";

const METHOD: Record<StageId, keyof LatticeAG> = {
  inspect: "inspect",
  shield: "shield",
  verify: "verify",
  record: "record",
  approve: "approve",
  receipt: "receipt",
  compensate: "compensate",
  break_loop: "breakLoop",
};

export async function runPipeline(
  lattice: LatticeAG,
  steps: PipelineStep[],
): Promise<AnyLatticeEvent[]> {
  const out: AnyLatticeEvent[] = [];
  for (const step of steps) {
    const method = METHOD[step.stage];
    const fn = lattice[method] as (input: unknown) => Promise<AnyLatticeEvent | AnyLatticeEvent[]>;
    const result = await fn.call(lattice, step.input);
    if (Array.isArray(result)) {
      out.push(...result);
    } else {
      out.push(result);
    }
  }
  return out;
}
