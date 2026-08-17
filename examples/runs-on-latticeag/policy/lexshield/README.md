# Demo LexShield pack

This pack is a placeholder so the flagship agent can call
`lexshield evaluate --tool write_file --args ... -c policy/lexshield --json`.

It documents an ALLOW for `write_file` targeting `out/config.yaml`. LexShield
is a phase 6 adapter. The demo agent invokes the binary itself when it is on
PATH. If `lexshield` is missing, the agent skips policy evaluation.
