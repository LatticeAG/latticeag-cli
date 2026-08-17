/**
 * D12: VEKINBOX_AUTO_APPROVE=1 is honored only for vk_test_ keys.
 * vk_live_ always waits for a human resolution.
 */

export const AUTO_APPROVE_RESOLVED_BY = "auto-approve-test";

export function shouldAutoApprove(env: NodeJS.ProcessEnv): boolean {
  if (env.VEKINBOX_AUTO_APPROVE !== "1") {
    return false;
  }
  const key = env.VEKINBOX_API_KEY ?? "";
  if (key.startsWith("vk_live_")) {
    return false;
  }
  return key.startsWith("vk_test_");
}
