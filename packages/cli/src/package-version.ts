import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readNamedVersion(
  pkgPath: string,
  name: string,
): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name?: string;
      version?: string;
    };
    if (pkg.name === name && pkg.version) {
      return pkg.version;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function resolvePackageVersion(name: string): string | undefined {
  const parts = name.split("/");
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 24; i++) {
    const candidate = path.join(dir, "node_modules", ...parts, "package.json");
    if (existsSync(candidate)) {
      const version = readNamedVersion(candidate, name);
      if (version) {
        return version;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  try {
    const resolved = import.meta.resolve(name);
    let walk = path.dirname(fileURLToPath(resolved));
    for (let i = 0; i < 12; i++) {
      const pkgPath = path.join(walk, "package.json");
      if (existsSync(pkgPath)) {
        const version = readNamedVersion(pkgPath, name);
        if (version) {
          return version;
        }
      }
      const parent = path.dirname(walk);
      if (parent === walk) {
        break;
      }
      walk = parent;
    }
  } catch {
    // package not in the import graph
  }
  return undefined;
}

export const KNOWN_ADAPTER_PACKAGES = [
  "@latticeag/adapter-axion",
  "@latticeag/adapter-visreplay",
  "@latticeag/adapter-lexverdict",
  "@latticeag/adapter-vekinbox",
  "@latticeag/adapter-viscompile",
  "@latticeag/adapter-lexshield",
  "@latticeag/adapter-polymesh",
  "@latticeag/adapter-stub",
] as const;

export function resolveAdapterVersions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pkgName of KNOWN_ADAPTER_PACKAGES) {
    const version = resolvePackageVersion(pkgName);
    if (version) {
      out[pkgName] = version;
    }
  }
  return out;
}
