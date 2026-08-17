#!/usr/bin/env node
import { Command } from "commander";
import { CLI_VERSION } from "./cli-version.js";
import { addGlobalOptions, applyGlobalOpts, readGlobalOpts } from "./globals.js";
import { registerInit } from "./commands/init.js";
import { registerRun } from "./commands/run.js";
import { registerDev } from "./commands/dev.js";
import { registerEvents } from "./commands/events.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerProducts } from "./commands/products.js";
import { registerVersion } from "./commands/version.js";

const TAGLINE =
  "The LatticeAG stack as one command. Every product event, one schema.";

const program = new Command();
program
  .name("latticeag")
  .description(TAGLINE)
  .version(CLI_VERSION, "-V, --version", "Print CLI semver and exit");

addGlobalOptions(program, false);

program.hook("preAction", (thisCommand) => {
  applyGlobalOpts(readGlobalOpts(thisCommand));
});

registerInit(program);
registerRun(program);
registerDev(program);
registerEvents(program);
registerDoctor(program);
registerProducts(program);
registerVersion(program);

await program.parseAsync(process.argv);
