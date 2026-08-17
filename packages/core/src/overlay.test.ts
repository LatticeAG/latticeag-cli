import { describe, expect, test } from "vitest";
import { overlayCreateOptions } from "./overlay.js";

describe("overlayCreateOptions", () => {
  test("create options beat env fixtures", () => {
    const overlay = overlayCreateOptions(
      {
        fixtures: {
          beliefs: "/create/beliefs.json",
          approvals: "/create/approvals.json",
          verdicts: "/create/verdicts.json",
        },
      },
      {
        LATTICEAG_FIXTURE_BELIEFS: "/env/beliefs.json",
        LATTICEAG_FIXTURE_APPROVALS: "/env/approvals.json",
        LATTICEAG_FIXTURE_VERDICTS: "/env/verdicts.json",
      },
    );
    expect(overlay.fixtures.beliefs).toBe("/create/beliefs.json");
    expect(overlay.fixtures.approvals).toBe("/create/approvals.json");
    expect(overlay.fixtures.verdicts).toBe("/create/verdicts.json");
  });

  test("env fixtures apply when create omits the key", () => {
    const overlay = overlayCreateOptions(
      {},
      {
        LATTICEAG_FIXTURE_BELIEFS: "/env/beliefs.json",
        LATTICEAG_FIXTURE_APPROVALS: "/env/approvals.json",
        LATTICEAG_FIXTURE_VERDICTS: "/env/verdicts.json",
      },
    );
    expect(overlay.fixtures.beliefs).toBe("/env/beliefs.json");
    expect(overlay.fixtures.approvals).toBe("/env/approvals.json");
    expect(overlay.fixtures.verdicts).toBe("/env/verdicts.json");
    expect(overlay.ingest).toBe(false);
    expect(overlay.auto).toEqual({
      verifyOnToolObserved: false,
      approveOnSteer: false,
      approveOnChallenge: false,
      receiptOnApproved: false,
    });
  });

  test("explicit stages.inspect.backend fixture is present in overlay", () => {
    const overlay = overlayCreateOptions(
      {
        stages: {
          inspect: { backend: "fixture", fixture: "/create/beliefs.json" },
        },
      },
      { LATTICEAG_FIXTURE_BELIEFS: "/env/beliefs.json" },
    );
    expect(overlay.stages.inspect?.backend).toBe("fixture");
    expect(overlay.stages.inspect?.fixture).toBe("/create/beliefs.json");
  });
});
