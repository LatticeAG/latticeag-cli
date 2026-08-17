# LatticeAG runs on LatticeAG

Flagship demo for `latticeag`. An OpenAI-compatible agent is asked to write
`out/config.yaml` with `env: production` and `replicas: 3`. Axion extracts an
assumption belief about staging. viscompile diffs the transcript. LexVerdict
steers the first write. VekInbox records an approval and a receipt. CI uses
`--offline-fixture` so the chain does not need a live model.

## How to run

```
cd examples/runs-on-latticeag
cp .env.example .env
# start Axion in another terminal: cd /home/ubuntu/repos/Axion && npm run dev
# start VekInbox: cd /home/ubuntu/repos/VekInbox && docker compose up --build
pnpm --filter @latticeag/example-runs-on-latticeag exec latticeag doctor
pnpm --filter @latticeag/example-runs-on-latticeag exec latticeag run \
  --attach openai-completions \
  --cmd "npx tsx src/agent.ts"
```

CI:

```
LATTICEAG_GOAL="Write production config.yaml with env: production and replicas: 3" \
VEKINBOX_AUTO_APPROVE=1 \
pnpm --filter @latticeag/example-runs-on-latticeag exec latticeag run \
  --fixture-beliefs fixtures/beliefs.json \
  --fixture-approvals fixtures/approvals.json \
  --attach custom \
  --cmd "npx tsx src/agent.ts --offline-fixture"
```

Then:

```
npx tsx src/assert-chain.ts .latticeag/events.jsonl
```

`assert-chain` exits 0 when `belief_extracted`, `verdict`, `approval_granted`,
and `receipt_issued` are present in that seq order and `out/config.yaml` is
the production file. If `lattice` is on PATH, `diff_computed` is required.
Otherwise an `adapter_error` whose message contains `lattice binary not found`
is required, unless `LATTICEAG_ALLOW_MISSING_DIFF=1`.
