import type { Command } from "commander";
import { Option } from "commander";
import {
  ADAPTER_NAMES,
  ConfigNotFoundError,
  loadConfig,
  type AdapterName,
  type LatticeagConfig,
} from "@latticeag/config";
import { addGlobalOptions, readGlobalOpts } from "../globals.js";
import { fail, writeJson } from "../json-envelope.js";
import { resolvePackageVersion } from "../package-version.js";
import {
  CATALOG,
  type AdapterStatus,
  type CatalogProduct,
} from "../catalog.js";

export interface ProductRow {
  slug: string;
  name: string;
  series: CatalogProduct["series"];
  site_status: CatalogProduct["site_status"];
  adapter: AdapterStatus;
  package: string | null;
  package_version: string | null;
}

export type ProductsStatusFilter = "wired" | "available" | "stub" | "all";

const SLUG_W = 13;
const SERIES_W = 8;
const SITE_W = 16;
const ADAPTER_W = 10;

function enabledFor(
  slug: string,
  config: LatticeagConfig | undefined,
): boolean {
  if (!config) {
    return false;
  }
  if ((ADAPTER_NAMES as readonly string[]).includes(slug)) {
    return config.adapters[slug as AdapterName].enabled;
  }
  return false;
}

export function adapterStatusFor(
  product: CatalogProduct,
  config: LatticeagConfig | undefined,
  versions: Record<string, string | undefined>,
): { adapter: AdapterStatus; package: string | null; package_version: string | null } {
  const pkg = product.adapter_package;
  if (!pkg) {
    return { adapter: "stub", package: null, package_version: null };
  }
  const version = versions[pkg];
  if (!version) {
    return { adapter: "stub", package: null, package_version: null };
  }
  const enabled = enabledFor(product.slug, config);
  return {
    adapter: enabled ? "wired" : "available",
    package: pkg,
    package_version: version,
  };
}

export function collectProductRows(
  config: LatticeagConfig | undefined,
): ProductRow[] {
  const versions: Record<string, string | undefined> = {};
  for (const product of CATALOG) {
    if (product.adapter_package && versions[product.adapter_package] === undefined) {
      versions[product.adapter_package] = resolvePackageVersion(
        product.adapter_package,
      );
    }
  }
  return CATALOG.map((product) => {
    const wiring = adapterStatusFor(product, config, versions);
    return {
      slug: product.slug,
      name: product.name,
      series: product.series,
      site_status: product.site_status,
      adapter: wiring.adapter,
      package: wiring.package,
      package_version: wiring.package_version,
    };
  });
}

export function formatProductsText(rows: ProductRow[]): string {
  const header = `${"slug".padEnd(SLUG_W)}${"series".padEnd(SERIES_W)}${"site_status".padEnd(SITE_W)}adapter`;
  const lines = [header];
  for (const row of rows) {
    const pkg =
      row.package && row.package_version
        ? `${row.package}@${row.package_version}`
        : "";
    const adapterCol = pkg
      ? `${row.adapter.padEnd(ADAPTER_W)}${pkg}`
      : row.adapter;
    lines.push(
      `${row.slug.padEnd(SLUG_W)}${row.series.padEnd(SERIES_W)}${row.site_status.padEnd(SITE_W)}${adapterCol}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function loadOptionalConfig(cwd: string): LatticeagConfig | undefined {
  try {
    return loadConfig(cwd).config;
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      return undefined;
    }
    throw err;
  }
}

export async function runProducts(raw: {
  status?: string;
  json?: boolean;
}): Promise<void> {
  const json = raw.json === true;
  const status = (raw.status ?? "all") as ProductsStatusFilter;
  if (!["wired", "available", "stub", "all"].includes(status)) {
    fail(`unknown --status ${raw.status}`, {
      json,
      command: "products",
      code: "USAGE",
    });
  }
  let config: LatticeagConfig | undefined;
  try {
    config = loadOptionalConfig(process.cwd());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), {
      json,
      command: "products",
      code: "CONFIG",
    });
  }
  const all = collectProductRows(config);
  const rows =
    status === "all" ? all : all.filter((row) => row.adapter === status);
  if (json) {
    writeJson("products", true, { products: rows });
    return;
  }
  process.stdout.write(formatProductsText(rows));
}

export function registerProducts(program: Command): void {
  const cmd = program
    .command("products")
    .description("List catalog products and adapter status.")
    .addOption(
      new Option("--status <wired|available|stub|all>", "Filter adapter status")
        .choices(["wired", "available", "stub", "all"])
        .default("all"),
    )
    .action(async (opts: Record<string, unknown>, command: Command) => {
      const globals = readGlobalOpts(command);
      await runProducts({
        status: opts.status as string | undefined,
        json: globals.json === true,
      });
    });
  addGlobalOptions(cmd);
}
