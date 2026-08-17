import type { Command } from "commander";
import type { AnyLatticeEvent } from "@latticeag/events";
import { addGlobalOptions, readGlobalOpts } from "../globals.js";
import { fail } from "../json-envelope.js";
import {
  addRunOptions,
  finishLatticeRun,
  printRunResult,
  runFlagsFromOpts,
  startLatticeRun,
  asText,
} from "./run.js";
import { summarizeEvent } from "./events-summary.js";

export const DEV_NEEDS_TTY =
  'latticeag dev needs a TTY. Use latticeag run --cmd "..." and latticeag events --follow --format ndjson';

export async function executeDev(
  opts: Record<string, unknown>,
  globals: { json?: boolean; verbose?: boolean; quiet?: boolean },
): Promise<void> {
  if (globals.json === true) {
    fail("latticeag dev cannot be used with --json", {
      json: true,
      command: "dev",
      code: "USAGE",
    });
  }
  if (process.stdout.isTTY !== true) {
    fail(DEV_NEEDS_TTY, {
      json: false,
      command: "dev",
      code: "USAGE",
    });
  }

  const flags = runFlagsFromOpts(opts, globals, { captureChild: true });
  const followTypes =
    typeof opts.followTypes === "string" && opts.followTypes.length > 0
      ? opts.followTypes.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  const ctx = await startLatticeRun(flags);
  const events: AnyLatticeEvent[] = [];
  ctx.bus.subscribe("*", (event) => {
    events.push(event);
  });

  const tui = await import("@latticeag/events-tui");
  let healthCache: Array<{ id: string; ok: boolean; detail: string }> = [];
  const refreshHealth = async (): Promise<void> => {
    healthCache = await Promise.all(ctx.adapters.map((a) => a.health()));
  };
  await refreshHealth();
  const healthTimer = setInterval(() => {
    void refreshHealth();
  }, 1000);

  const instance = tui.renderDevApp({
    runId: ctx.run_id,
    getSeq: () => ctx.bus.seq(),
    getEvents: () =>
      followTypes.length === 0
        ? events
        : events.filter((e) => followTypes.includes(e.name)),
    getHealth: () => healthCache,
    summarize: summarizeEvent,
    onQuit: () => {
      ctx.child.kill("SIGTERM");
    },
  });

  let childExit = 1;
  let captured = { stdout: "", stderr: "" };
  try {
    const finished = await ctx.child;
    childExit = finished.exitCode ?? (finished.failed ? 1 : 0);
    captured = {
      stdout: asText(finished.stdout),
      stderr: asText(finished.stderr),
    };
  } catch (err) {
    childExit = 127;
    captured = {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }

  clearInterval(healthTimer);
  instance.unmount();
  await instance.waitUntilExit().catch(() => undefined);

  const result = await finishLatticeRun(ctx, flags, childExit, captured);
  const ok = childExit === 0;
  printRunResult(result, flags, ok);
  if (!ok) {
    process.exit(2);
  }
}

export function registerDev(program: Command): void {
  const cmd = program
    .command("dev")
    .description("Run with a live event TUI.")
    .option(
      "--follow-types <list>",
      "TUI filter, comma list of first-class event names",
    )
    .action(async (opts: Record<string, unknown>, command: Command) => {
      const globals = readGlobalOpts(command);
      await executeDev(opts, globals);
    });
  addRunOptions(cmd);
  addGlobalOptions(cmd);
}
