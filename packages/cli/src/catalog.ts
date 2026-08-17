export type ProductSeries = "poly" | "lex" | "vek" | "axi" | "vis" | "forge";
export type SiteStatus = "skill" | "coming-soon" | "invite-only" | "open-source";
export type AdapterStatus = "wired" | "available" | "stub";

export interface CatalogProduct {
  slug: string;
  name: string;
  series: ProductSeries;
  site_status: SiteStatus;
  /** Dedicated adapter package, or null when only adapter-stub applies. */
  adapter_package: string | null;
}

export const SERIES_ORDER: ProductSeries[] = [
  "poly",
  "lex",
  "vek",
  "axi",
  "vis",
  "forge",
];

/**
 * 19 catalog products. Order: series Poly, Lex, Vek, Axi, Vis, Forge,
 * then slug ascending inside series.
 */
export const CATALOG: CatalogProduct[] = [
  {
    slug: "polybrain",
    name: "PolyBrain",
    series: "poly",
    site_status: "skill",
    adapter_package: null,
  },
  {
    slug: "polyflow",
    name: "PolyFlow",
    series: "poly",
    site_status: "coming-soon",
    adapter_package: null,
  },
  {
    slug: "polygnosis",
    name: "PolyGnosis",
    series: "poly",
    site_status: "skill",
    adapter_package: null,
  },
  {
    slug: "polymesh",
    name: "PolyMesh",
    series: "poly",
    site_status: "open-source",
    adapter_package: "@latticeag/adapter-polymesh",
  },
  {
    slug: "polyscribe",
    name: "PolyScribe",
    series: "poly",
    site_status: "open-source",
    adapter_package: null,
  },
  {
    slug: "lexgateway",
    name: "LexGateway",
    series: "lex",
    site_status: "invite-only",
    adapter_package: "@latticeag/lexgateway-proxy",
  },
  {
    slug: "lexrapid",
    name: "LexRapid",
    series: "lex",
    site_status: "invite-only",
    adapter_package: null,
  },
  {
    slug: "lexrouter",
    name: "LexRouter",
    series: "lex",
    site_status: "coming-soon",
    adapter_package: null,
  },
  {
    slug: "lexshield",
    name: "LexShield",
    series: "lex",
    site_status: "open-source",
    adapter_package: "@latticeag/adapter-lexshield",
  },
  {
    slug: "lexverdict",
    name: "LexVerdict",
    series: "lex",
    site_status: "open-source",
    adapter_package: "@latticeag/adapter-lexverdict",
  },
  {
    slug: "vekdata",
    name: "VekData",
    series: "vek",
    site_status: "coming-soon",
    adapter_package: null,
  },
  {
    slug: "vekinbox",
    name: "VekInbox",
    series: "vek",
    site_status: "open-source",
    adapter_package: "@latticeag/adapter-vekinbox",
  },
  {
    slug: "vektor",
    name: "VekTor",
    series: "vek",
    site_status: "coming-soon",
    adapter_package: null,
  },
  {
    slug: "axicontext",
    name: "AxiContext",
    series: "axi",
    site_status: "open-source",
    adapter_package: null,
  },
  {
    slug: "axion",
    name: "Axion",
    series: "vis",
    site_status: "open-source",
    adapter_package: "@latticeag/adapter-axion",
  },
  {
    slug: "visboard",
    name: "VisBoard",
    series: "vis",
    site_status: "open-source",
    adapter_package: null,
  },
  {
    slug: "viscompile",
    name: "VisCompile",
    series: "vis",
    site_status: "open-source",
    adapter_package: "@latticeag/adapter-viscompile",
  },
  {
    slug: "visreplay",
    name: "VisReplay",
    series: "vis",
    site_status: "open-source",
    adapter_package: "@latticeag/adapter-visreplay",
  },
  {
    slug: "forgedistill",
    name: "ForgeDistill",
    series: "forge",
    site_status: "open-source",
    adapter_package: null,
  },
];

export function assertCatalogOrder(rows: CatalogProduct[]): void {
  const seriesRank = new Map(SERIES_ORDER.map((s, i) => [s, i]));
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (!prev || !cur) {
      continue;
    }
    const pr = seriesRank.get(prev.series) ?? 99;
    const cr = seriesRank.get(cur.series) ?? 99;
    if (pr < cr) {
      continue;
    }
    if (pr === cr && prev.slug <= cur.slug) {
      continue;
    }
    throw new Error(`catalog order broken at ${prev.slug} -> ${cur.slug}`);
  }
}

assertCatalogOrder(CATALOG);
