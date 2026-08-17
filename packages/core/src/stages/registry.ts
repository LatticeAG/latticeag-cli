import type { AnyLatticeEvent } from "@latticeag/events";
import { ConfigError } from "../errors.js";
import type { StageId } from "../types.js";
import type { StageHandler } from "./types.js";

const LOCKED: ReadonlySet<StageId> = new Set(["inspect", "verify", "record", "approve"]);
const STUBS: ReadonlySet<StageId> = new Set(["shield", "compensate", "break_loop", "receipt"]);

export class StageRegistry {
  readonly handlers = new Map<StageId, StageHandler<unknown, AnyLatticeEvent | AnyLatticeEvent[]>>();

  register(
    handler: StageHandler<unknown, AnyLatticeEvent | AnyLatticeEvent[]>,
    env: NodeJS.ProcessEnv,
  ): void {
    if (!handler.adapter.startsWith("@latticeag/") && handler.adapter !== "latticeag-internal") {
      throw new ConfigError(
        "CONFIG_INVALID",
        `handler.adapter must start with @latticeag/ or equal latticeag-internal: ${handler.adapter}`,
      );
    }
    if (LOCKED.has(handler.id)) {
      throw new ConfigError("STAGE_LOCKED", `cannot replace locked stage ${handler.id}`);
    }
    if (this.handlers.has(handler.id)) {
      const replacingReceipt =
        handler.id === "receipt" &&
        env.LATTICEAG_RECEIPT_PROVIDER === "visreceipt";
      if (!STUBS.has(handler.id) && !replacingReceipt) {
        throw new ConfigError("STAGE_LOCKED", `duplicate stage ${handler.id}`);
      }
      if (handler.id === "receipt" && !replacingReceipt) {
        throw new ConfigError(
          "STAGE_LOCKED",
          "receipt replacement requires LATTICEAG_RECEIPT_PROVIDER=visreceipt",
        );
      }
    }
    this.handlers.set(handler.id, handler);
  }

  get(id: StageId): StageHandler<unknown, AnyLatticeEvent | AnyLatticeEvent[]> | undefined {
    return this.handlers.get(id);
  }

  ids(): Set<StageId> {
    return new Set(this.handlers.keys());
  }
}
