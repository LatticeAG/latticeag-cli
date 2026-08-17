import type { AgentAttachKit } from "./types.js";
import { injectAxionBaseUrls } from "./types.js";

export const openaiCompletionsKit: AgentAttachKit = {
  id: "openai-completions",
  detect(env, argv) {
    if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0) {
      return true;
    }
    return argv.some((token) => /openai/i.test(token));
  },
  injectEnv(env, ctx) {
    return injectAxionBaseUrls(env, ctx);
  },
};
