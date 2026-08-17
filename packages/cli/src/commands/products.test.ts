import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, SERIES_ORDER } from "../catalog.js";
import { runCli } from "../test-spawn.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "latticeag-products-"));
}

describe("catalog", () => {
  it("has 19 products in series then slug order", () => {
    expect(CATALOG).toHaveLength(19);
    const rank = new Map(SERIES_ORDER.map((s, i) => [s, i]));
    for (let i = 1; i < CATALOG.length; i++) {
      const prev = CATALOG[i - 1];
      const cur = CATALOG[i];
      expect(prev && cur).toBeTruthy();
      if (!prev || !cur) {
        continue;
      }
      const pr = rank.get(prev.series) ?? 0;
      const cr = rank.get(cur.series) ?? 0;
      if (pr === cr) {
        expect(prev.slug < cur.slug).toBe(true);
      } else {
        expect(pr < cr).toBe(true);
      }
    }
  });
});

describe("latticeag products", () => {
  it("--json after default init has 19 rows and four wired adapters", async () => {
    const dir = tempDir();
    const init = await runCli(["init", dir, "--template", "blank"]);
    expect(init.status).toBe(0);
    const result = await runCli(["--cwd", dir, "products", "--json"]);
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      data: {
        products: Array<{
          slug: string;
          adapter: string;
          series: string;
          site_status: string;
        }>;
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("products");
    expect(envelope.data.products).toHaveLength(19);
    const wired = envelope.data.products.filter((p) => p.adapter === "wired");
    expect(wired.map((p) => p.slug).sort()).toEqual(
      ["axion", "lexverdict", "vekinbox", "visreplay"].sort(),
    );
    const bySlug = Object.fromEntries(
      envelope.data.products.map((p) => [p.slug, p]),
    );
    expect(bySlug.polybrain?.site_status).toBe("skill");
    expect(bySlug.polygnosis?.site_status).toBe("skill");
    expect(bySlug.polyflow?.site_status).toBe("coming-soon");
    expect(bySlug.lexrouter?.site_status).toBe("coming-soon");
    expect(bySlug.vektor?.site_status).toBe("coming-soon");
    expect(bySlug.vekdata?.site_status).toBe("coming-soon");
    expect(bySlug.lexgateway?.site_status).toBe("invite-only");
    expect(bySlug.lexrapid?.site_status).toBe("invite-only");
    expect(bySlug.axion?.site_status).toBe("open-source");
    expect(bySlug.viscompile?.adapter).toBe("available");
    expect(bySlug.lexshield?.adapter).toBe("stub");
    expect(bySlug.polymesh?.adapter).toBe("stub");
    expect(bySlug.lexgateway?.adapter).toBe("stub");
  });

  it("--status all text includes every slug", async () => {
    const dir = tempDir();
    await runCli(["init", dir, "--template", "blank"]);
    const result = await runCli(["--cwd", dir, "products"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^slug\s+series\s+site_status\s+adapter/m);
    for (const product of CATALOG) {
      expect(result.stdout).toContain(product.slug);
    }
  });
});
