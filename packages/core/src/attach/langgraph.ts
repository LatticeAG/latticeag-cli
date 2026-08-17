import type { JsonObject, JsonValue, ToolObservedEvent } from "@latticeag/events";
import { LatticeAGError } from "../errors.js";
import type { LatticeAG } from "../lattice.js";

export interface LangGraphCallback {
  handleToolStart(info: { name: string; runId: string; inputs: JsonObject }): void;
  handleToolEnd(info: { runId: string; output: JsonValue }): Promise<ToolObservedEvent>;
  handleToolError(info: { runId: string; error: string }): Promise<ToolObservedEvent>;
  handleLLMEnd?(info: { text: string }): Promise<void>;
}

export function createLangGraphCallback(
  lattice: LatticeAG,
  opts?: { inspectOnLlmEnd?: boolean },
): LangGraphCallback {
  const pending = new Map<string, { name: string; inputs: JsonObject }>();
  return {
    handleToolStart(info) {
      pending.set(info.runId, { name: info.name, inputs: info.inputs });
    },
    async handleToolEnd(info) {
      const start = pending.get(info.runId);
      pending.delete(info.runId);
      if (!start) {
        throw new LatticeAGError("LANGGRAPH_TOOL_UNMATCHED", `no handleToolStart for ${info.runId}`);
      }
      return lattice.observeTool({
        source: "visreplay",
        name: start.name,
        arguments: start.inputs,
        result: info.output,
      });
    },
    async handleToolError(info) {
      const start = pending.get(info.runId);
      pending.delete(info.runId);
      if (!start) {
        throw new LatticeAGError("LANGGRAPH_TOOL_UNMATCHED", `no handleToolStart for ${info.runId}`);
      }
      return lattice.observeTool({
        source: "visreplay",
        name: start.name,
        arguments: start.inputs,
        error: info.error,
      });
    },
    async handleLLMEnd(info) {
      if (!opts?.inspectOnLlmEnd) return;
      await lattice.inspect({ source: "text", text: info.text });
    },
  };
}
