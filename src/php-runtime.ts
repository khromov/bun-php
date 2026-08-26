import { PHP, loadPHPRuntime } from "@php-wasm/universal";
import type { MountHandler } from "@php-wasm/universal";

/**
 * The only module that touches `@php-wasm/*` directly.
 *
 * `@php-wasm/node-8-5` ships just the WebAssembly builds and a loader; the JS
 * API (`PHP`, `loadPHPRuntime`) lives in `@php-wasm/universal`. The convenience
 * adapter `@php-wasm/node` is deliberately not used: it statically imports
 * `fs-ext-extra-prebuilt`, a NAN native addon that throws at module-evaluation
 * time when its binding cannot load, and it depends on every per-version build
 * package. Going direct keeps the dependency tree pure JavaScript.
 */
export const PHP_VERSION = "8.5";

/** Versions with a `@php-wasm/node-X-Y` build package. */
export type PhpVersion = "8.0" | "8.1" | "8.2" | "8.3" | "8.4" | "8.5";

/** What `@php-wasm/node-X-Y` exports; `loadPHPRuntime` takes it verbatim. */
export type PhpLoaderModule = Parameters<typeof loadPHPRuntime>[0];

/** Supply a build php-wasm has no package for, or pin the jspi/asyncify variant. */
export type PhpLoader = () => Promise<PhpLoaderModule>;

export interface PhpRuntimeSource {
  /** Defaults to {@link PHP_VERSION}; anything else must be installed by the caller. */
  phpVersion?: PhpVersion;
  /** Takes precedence over `phpVersion`. */
  loader?: PhpLoader;
}

/**
 * Only the default is a real dependency. Every other build is an optional peer:
 * bundling all of them would cost ~60 MB of wasm per version and undo the
 * pure-JavaScript dependency tree the direct `@php-wasm/universal` import buys.
 */
const BUILD_PACKAGES: Record<PhpVersion, string> = {
  "8.0": "@php-wasm/node-8-0",
  "8.1": "@php-wasm/node-8-1",
  "8.2": "@php-wasm/node-8-2",
  "8.3": "@php-wasm/node-8-3",
  "8.4": "@php-wasm/node-8-4",
  "8.5": "@php-wasm/node-8-5",
};

/** A build package is missing far more often than it is broken, so say which one. */
export class PhpBuildNotInstalledError extends Error {
  override readonly name = "PhpBuildNotInstalledError";
  constructor(
    readonly phpVersion: PhpVersion,
    readonly packageName: string,
    cause: unknown,
  ) {
    super(
      `PHP ${phpVersion} needs ${packageName}, which is not installed. ` +
        `Run \`bun add ${packageName}\`, or pass \`loader\` to supply the build yourself.`,
      { cause },
    );
  }
}

async function loadBuild(phpVersion: PhpVersion): Promise<PhpLoaderModule> {
  const packageName = BUILD_PACKAGES[phpVersion];
  let build: { getPHPLoaderModule(): Promise<PhpLoaderModule> };
  try {
    build = await import(packageName);
  } catch (err) {
    throw new PhpBuildNotInstalledError(phpVersion, packageName, err);
  }
  // Every build package picks jspi over asyncify itself; `loader` is the way past that.
  return build.getPHPLoaderModule();
}

/** Instantiate a fresh php-wasm runtime and return its id. */
export async function createRuntimeId(source: PhpRuntimeSource = {}): Promise<number> {
  const load = source.loader ?? (() => loadBuild(source.phpVersion ?? PHP_VERSION));
  return loadPHPRuntime(await load());
}

/** Boot a new PHP interpreter. */
export async function bootPhp(source: PhpRuntimeSource = {}): Promise<PHP> {
  return new PHP(await createRuntimeId(source));
}

/**
 * Mount a real host directory into the virtual filesystem.
 *
 * `@php-wasm/node` ships `createNodeFsMountHandler` for this, but that package
 * is avoided here (see above), so the handler is implemented directly against
 * the Emscripten filesystem. NODEFS is a live view: files written on the host
 * after mounting are visible to PHP straight away.
 */
export function nodeFsMountHandler(hostPath: string): MountHandler {
  return (_php, FS, mountPoint) => {
    const fs = FS as unknown as {
      filesystems: Record<string, unknown>;
      mount(type: unknown, options: unknown, target: string): void;
      unmount(target: string): void;
    };
    fs.mount(fs.filesystems.NODEFS, { root: hostPath }, mountPoint);
    return () => fs.unmount(mountPoint);
  };
}
