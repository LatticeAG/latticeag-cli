import type {
  AutoChainOptions,
  LatticeAGCreateOptions,
  StageBackendOverride,
  StageId,
} from "./types.js";

export interface CreateOptionsOverlay {
  ingest: boolean;
  auto: Required<AutoChainOptions>;
  stages: Partial<Record<StageId, StageBackendOverride>>;
  fixtures: {
    beliefs?: string;
    approvals?: string;
    verdicts?: string;
    receipts?: string;
  };
}

function pickFixture(createValue: string | undefined, envValue: string | undefined): string | undefined {
  if (createValue !== undefined) {
    return createValue;
  }
  if (envValue !== undefined && envValue.length > 0) {
    return envValue;
  }
  return undefined;
}

export function overlayCreateOptions(
  opts: LatticeAGCreateOptions,
  env: NodeJS.ProcessEnv,
): CreateOptionsOverlay {
  const fixtures = opts.fixtures;
  return {
    ingest: opts.ingest ?? false,
    auto: {
      verifyOnToolObserved: opts.auto?.verifyOnToolObserved ?? false,
      approveOnSteer: opts.auto?.approveOnSteer ?? false,
      approveOnChallenge: opts.auto?.approveOnChallenge ?? false,
      receiptOnApproved: opts.auto?.receiptOnApproved ?? false,
    },
    stages: { ...opts.stages },
    fixtures: {
      beliefs: pickFixture(fixtures?.beliefs, env.LATTICEAG_FIXTURE_BELIEFS),
      approvals: pickFixture(fixtures?.approvals, env.LATTICEAG_FIXTURE_APPROVALS),
      verdicts: pickFixture(fixtures?.verdicts, env.LATTICEAG_FIXTURE_VERDICTS),
      receipts: fixtures?.receipts,
    },
  };
}
