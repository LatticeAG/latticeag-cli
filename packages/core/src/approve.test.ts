import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnyLatticeEvent, ExtensionEvent } from "@latticeag/events";
import { describe, expect, test } from "vitest";
import { ApprovalRejectedError } from "./errors.js";
import { shouldAutoApprove } from "./stages/approve.js";
import { createFixtureLattice, tmpProject } from "./test-harness.js";

describe("approve", () => {
  test("approved fixture granted with payload.status approved", async () => {
    const { lattice } = await createFixtureLattice();
    try {
      const tool = await lattice.observeTool({
        source: "visreplay",
        name: "write_file",
        arguments: { path: "a" },
        result: { ok: true },
      });
      const steer = await lattice.verify({
        causation_id: tool.id,
        name: "write_file",
        arguments: tool.payload.arguments,
        result: tool.payload.result,
      });
      expect(steer.payload.verdict).toBe("steer");
      const granted = await lattice.approve({ causation_id: steer.id, source: "verdict" });
      expect(granted.payload.status).toBe("approved");
    } finally {
      await lattice.close();
    }
  });

  test("declined emits vekinbox.approval_resolved and throws ApprovalRejectedError", async () => {
    const dir = await tmpProject();
    const approvalsPath = join(dir, "approvals-declined.json");
    await writeFile(
      approvalsPath,
      JSON.stringify([
        {
          key: "RUN.CAUSE",
          request_id: "req_01ARZ3NDEKTSV4RRFFQ69G5FAX",
          status: "declined",
          title: "Decline after verdict",
          action: "write_file",
          workspace_id: "ws_test",
          agent_id: "agt_test",
          resolved_at: "2026-08-17T13:57:00.123Z",
          priority: "normal",
        },
      ]),
    );
    const { lattice } = await createFixtureLattice({
      cwd: dir,
      fixtures: { approvals: approvalsPath },
    });
    try {
      const seen: AnyLatticeEvent[] = [];
      lattice.on("*", (event) => {
        seen.push(event);
      });
      await expect(
        lattice.approve({ causation_id: "manual-cause", source: "manual" }),
      ).rejects.toBeInstanceOf(ApprovalRejectedError);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const ext = seen.find((event) => event.name === "extension") as ExtensionEvent | undefined;
      expect(ext?.payload.extension_name).toBe("vekinbox.approval_resolved");
    } finally {
      await lattice.close();
    }
  });

  test("vk_live_ auto-approve ignored", () => {
    expect(
      shouldAutoApprove({ VEKINBOX_AUTO_APPROVE: "1", VEKINBOX_API_KEY: "vk_live_abc" }),
    ).toBe(false);
    expect(
      shouldAutoApprove({ VEKINBOX_AUTO_APPROVE: "1", VEKINBOX_API_KEY: "vk_test_abc" }),
    ).toBe(true);
  });
});
