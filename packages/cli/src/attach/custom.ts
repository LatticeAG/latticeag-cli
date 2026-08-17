import type { AgentAttachKit } from "./types.js";

export const customKit: AgentAttachKit = {
  id: "custom",
  detect(_env, _argv) {
    return false;
  },
  injectEnv(env) {
    return { ...env };
  },
};
