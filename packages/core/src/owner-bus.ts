/** C8: core constructs LatticeBus with CLI section 11 BusOptions in owner mode. */
export { LatticeBus, BusPersistError, type Subscriber, type EmitPartial } from "@latticeag/bus";
import { LatticeBus } from "@latticeag/bus";
import type { BusOptions as CoreBusOptions } from "./types.js";

export function createOwnerBus(options: CoreBusOptions): LatticeBus {
  return new LatticeBus({
    run_id: options.run_id,
    session_id: options.session_id,
    log_path: options.log_path,
    ring_capacity: options.ring_capacity,
    overflow_block_ms: options.overflow_block_ms,
    overflow: options.overflow,
    persist_fail: options.persist_fail,
    redact_keys: options.redact_keys,
    include_raw_text: options.include_raw_text,
    max_log_bytes: options.max_log_bytes ?? 268435456,
  });
}
