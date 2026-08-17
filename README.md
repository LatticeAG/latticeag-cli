# latticeag

The LatticeAG stack as one command. Every product event, one schema.

`latticeag` installs, wires, and runs LatticeAG products as one local system. Beliefs, diffs, verdicts, approvals, and receipts share a single versioned event model (`@latticeag/events`).

```
pnpm add -g @latticeag/cli
latticeag init
latticeag doctor
latticeag run --attach openai-completions --cmd "npx tsx src/agent.ts"
```

OSS MIT: CLI, events schema, adapters, local bus, reference demo. Hosted LexGateway relay is invite-only.

Website: https://latticeag.vercel.app
