import { customKit } from "./custom.js";
import { hermesKit } from "./hermes.js";
import { langgraphKit } from "./langgraph.js";
import { openaiAgentsKit } from "./openai-agents.js";
import { openaiCompletionsKit } from "./openai-completions.js";
import type { AgentAttachKit, AttachKitId } from "./types.js";

export type {
  AgentAttachKit,
  AttachInjectCtx,
  AttachKitId,
} from "./types.js";
export { injectAxionBaseUrls } from "./types.js";

export const ATTACH_KIT_IDS: AttachKitId[] = [
  "openai-completions",
  "openai-agents",
  "hermes",
  "langgraph",
  "custom",
];

const KITS: Record<AttachKitId, AgentAttachKit> = {
  "openai-completions": openaiCompletionsKit,
  "openai-agents": openaiAgentsKit,
  hermes: hermesKit,
  langgraph: langgraphKit,
  custom: customKit,
};

export function isAttachKitId(value: string): value is AttachKitId {
  return (ATTACH_KIT_IDS as string[]).includes(value);
}

export function getAttachKit(id: AttachKitId): AgentAttachKit {
  return KITS[id];
}

export function listAttachKits(): AgentAttachKit[] {
  return ATTACH_KIT_IDS.map((id) => KITS[id]);
}

export function suggestAttachKit(
  env: NodeJS.ProcessEnv,
  argv: string[],
): AttachKitId | undefined {
  for (const kit of listAttachKits()) {
    if (kit.id === "custom") {
      continue;
    }
    if (kit.detect(env, argv)) {
      return kit.id;
    }
  }
  return undefined;
}
