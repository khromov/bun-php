import { PHP, loadPHPRuntime, setPhpIniEntries } from "@php-wasm/universal";
import type { MountHandler, SpawnHandler } from "@php-wasm/universal";
import { EventEmitter } from "node:events";
import type { JournalOp, PhpLoaderModule, PhpRuntimeOptions, PhpVersion } from "./types";

export const PHP_VERSION: PhpVersion = "8.5";

// Only 8.5 is a real dependency: each build is tens of MB of wasm, so the rest are optional peers.
const BUILD_PACKAGES: Record<PhpVersion, string> = {
  "8.0": "@php-wasm/node-8-0",
  "8.1": "@php-wasm/node-8-1",
  "8.2": "@php-wasm/node-8-2",
  "8.3": "@php-wasm/node-8-3",
  "8.4": "@php-wasm/node-8-4",
  "8.5": "@php-wasm/node-8-5",
};

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

/** A build package that resolved but could not be loaded: a bad wasm asset, a throwing module, ... */
export class PhpBuildLoadError extends Error {
  override readonly name = "PhpBuildLoadError";
  constructor(
    readonly phpVersion: PhpVersion,
    readonly packageName: string,
    cause: unknown,
  ) {
    super(
      `PHP ${phpVersion} build ${packageName} is installed but failed to load; see the cause.`,
      { cause },
    );
  }
}

/** Only a resolution failure means "not installed"; anything else came out of the build itself. */
export function buildImportError(
  phpVersion: PhpVersion,
  packageName: string,
  cause: unknown,
): PhpBuildNotInstalledError | PhpBuildLoadError {
  const { code, specifier } = (cause ?? {}) as { code?: unknown; specifier?: unknown };
  // A transitive dependency failing to resolve is a broken build, not a missing one, so `bun add`
  // would be useless advice; only the build package's own specifier earns it.
  const missingBuild =
    code === "ERR_MODULE_NOT_FOUND" && (specifier ?? packageName) === packageName;
  return missingBuild
    ? new PhpBuildNotInstalledError(phpVersion, packageName, cause)
    : new PhpBuildLoadError(phpVersion, packageName, cause);
}

async function loadBuild(phpVersion: PhpVersion): Promise<PhpLoaderModule> {
  const packageName = BUILD_PACKAGES[phpVersion];
  let build: { getPHPLoaderModule(): Promise<PhpLoaderModule> };
  try {
    build = await import(packageName);
  } catch (err) {
    throw buildImportError(phpVersion, packageName, err);
  }
  return build.getPHPLoaderModule();
}

/**
 * Short tags are off on every build, and not negotiable: php-parser reads `<?` as markup, and a
 * runtime that disagreed made a `<?` file export nothing and a `<?` snippet fail to parse. PHP's
 * own default is on only because no `php.ini` ships with the wasm builds. `<?=` is unaffected.
 */
export const PINNED_INI: Readonly<Record<string, string>> = { short_open_tag: "0" };

/** Boot a configured interpreter: spawn handler first, then every journal op, then what we pin. */
export async function bootPhp(
  options: PhpRuntimeOptions = {},
  ops: readonly JournalOp[] = [],
): Promise<PHP> {
  const load = options.loader ?? (() => loadBuild(options.phpVersion ?? PHP_VERSION));
  const php = new PHP(await loadPHPRuntime(await load()));
  if (options.spawn) {
    await php.setSpawnHandler(options.spawn === "refuse" ? refuseSpawn : options.spawn);
  }
  for (const op of ops) await applyOp(php, op);
  // Last, so no journal op can leave the runtime disagreeing with the parser.
  await setPhpIniEntries(php, { ...PINNED_INI });
  return php;
}

/** Say so rather than let a pinned entry look like it took effect. */
export function warnIfPinned(entries: Record<string, string | number>): void {
  const pinned = Object.keys(entries).filter((key) => key in PINNED_INI);
  if (pinned.length === 0) return;
  console.warn(
    `bun-php: ignoring php.ini ${pinned.join(", ")} — bun-php pins ${pinned
      .map((key) => `${key}=${PINNED_INI[key]}`)
      .join(", ")} because its parser depends on it. Open PHP with \`<?php\`.`,
  );
}

/** The `ini` and `mounts` options as journal ops, so one mechanism configures every instance. */
export function optionOps(options: PhpRuntimeOptions): JournalOp[] {
  const ops: JournalOp[] = [];
  if (options.ini) {
    warnIfPinned(options.ini);
    ops.push({ kind: "ini", entries: options.ini });
  }
  for (const { host, at } of options.mounts ?? []) ops.push({ kind: "mount", host, at });
  return ops;
}

export function writeFileOp(path: string, data: string | Uint8Array): JournalOp {
  if (typeof data === "string") return { kind: "writeFile", path, data, encoding: "utf8" };
  return {
    kind: "writeFile",
    path,
    data: Buffer.from(data).toString("base64"),
    encoding: "base64",
  };
}

export async function applyOp(php: PHP, op: JournalOp): Promise<void> {
  switch (op.kind) {
    case "mount":
      php.mkdir(op.at);
      await php.mount(op.at, nodeFsMountHandler(op.host));
      return;
    case "writeFile":
      php.writeFile(
        op.path,
        op.encoding === "base64" ? new Uint8Array(Buffer.from(op.data, "base64")) : op.data,
      );
      return;
    case "mkdir":
      php.mkdir(op.path);
      return;
    case "ini":
      await setPhpIniEntries(php, op.entries);
      return;
  }
}

/**
 * A live view of a host directory. `@php-wasm/node` ships one of these, but that package drags
 * in a native addon that throws when its binding cannot load.
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

// Answers every spawn with exit code 1 straight away; an unanswered spawn hangs the wasm bridge.
const refuseSpawn: SpawnHandler = () => {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  queueMicrotask(() => {
    child.emit("exit", 1);
    child.emit("close", 1);
  });
  return child as unknown as ReturnType<SpawnHandler>;
};
