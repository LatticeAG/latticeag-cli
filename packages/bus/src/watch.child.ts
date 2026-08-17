import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LatticeBus } from "./bus.js";
import { newEnvelopeId, newRunId, newSessionId } from "./ids.js";

const logPath = process.argv[2];
const runId = process.argv[3] ?? newRunId();
const sessionId = process.argv[4] ?? newSessionId();

if (!logPath) {
  throw new Error("usage: watch.child.ts <log_path> [run_id] [session_id]");
}

mkdirSync(dirname(logPath), { recursive: true });

const bus = new LatticeBus({
  run_id: runId,
  session_id: sessionId,
  log_path: logPath,
  ring_capacity: 100,
  overflow_block_ms: 10,
  overflow: "drop",
  persist_fail: "throw",
  redact_keys: [],
  include_raw_text: false,
  max_log_bytes: 268435456,
});

await bus.emit({
  name: "extension",
  producer: {
    product: "latticeag",
    adapter: "latticeag-internal",
    adapter_version: "0.1.0",
  },
  correlation_id: newEnvelopeId(),
  payload: {
    extension_name: "watch.ping",
    payload: { ok: true },
  },
});

await bus.close();
