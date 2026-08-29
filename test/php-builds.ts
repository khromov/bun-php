/**
 * Which `@php-wasm/node-X-Y` builds this checkout actually has, and which of them a run should
 * cover. The builds are optional peer dependencies, so most checkouts hold only 8.3 and 8.5.
 */
import { BUILD_PACKAGES } from "../src/php-runtime";
import type { PhpVersion } from "../src/types";

/** A version to exercise; `null` means "construct with no `phpVersion`", the built-in default. */
export interface VersionTarget {
  label: string;
  version: PhpVersion | null;
}

const ALL = Object.keys(BUILD_PACKAGES) as PhpVersion[];

export function isBuildInstalled(version: PhpVersion): boolean {
  try {
    Bun.resolveSync(BUILD_PACKAGES[version], import.meta.dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * `BUN_PHP_VERSIONS` names the targets ("8.1", "8.0,8.4", or "default"); unset covers every build
 * that happens to be installed. An explicitly named one is never filtered out, or a CI job whose
 * install step failed would pass by running nothing at all.
 */
export function versionTargets(): VersionTarget[] {
  const requested = process.env.BUN_PHP_VERSIONS?.trim();
  if (!requested) {
    return ALL.filter(isBuildInstalled).map((version) => ({ label: version, version }));
  }

  return requested.split(",").map((entry) => {
    const label = entry.trim();
    if (label === "default") return { label, version: null };
    if (!ALL.includes(label as PhpVersion)) {
      throw new Error(`BUN_PHP_VERSIONS: ${label} is not one of ${ALL.join(", ")}, default`);
    }
    return { label, version: label as PhpVersion };
  });
}
