import type { PHP, PHPLoaderModule, SpawnHandler } from "@php-wasm/universal";

/** Any value that can cross the JS <-> PHP boundary (JSON-encodable). */
export type PhpValue = string | number | boolean | null | PhpValue[] | { [key: string]: PhpValue };

/** A PHP `array`: a list when keys are sequential, an object otherwise. */
export type PhpArray = PhpValue[] | { [key: string]: PhpValue };

export interface PhpParamMeta {
  /** Without the leading `$`. */
  name: string;
  tsType: string;
  /** Has a default value. */
  optional: boolean;
  variadic: boolean;
  /** `&$x`. Arguments cross by value, so writes are not reflected back. */
  byref: boolean;
}

export interface PhpFunctionMeta {
  /** The name exported to JavaScript (namespace-stripped). */
  exportName: string;
  /** The fully-qualified name used to call into PHP. */
  phpName: string;
  params: PhpParamMeta[];
  returnTsType: string;
  /** Docblock summary, if any. */
  doc: string | null;
}

export interface PhpConstantMeta {
  name: string;
  value: PhpValue;
}

export interface PhpModuleMeta {
  functions: PhpFunctionMeta[];
  constants: PhpConstantMeta[];
  /** Declarations that could not be exported, and why. */
  skipped: string[];
}

/** Where PHP's own `echo`/`print` output goes. */
export type StdoutMode = "inherit" | "capture" | "ignore";

export interface PhpModuleApi {
  /** Call a PHP function by its fully-qualified name. */
  call(name: string, args: readonly unknown[]): Promise<any>;
  /** Boot the interpreter without calling anything. */
  $ready(): Promise<void>;
  /** Discard all PHP state; the next call boots a fresh interpreter. */
  $reset(): Promise<void>;
  /** Shut the interpreter down and drop it from the cache. */
  $dispose(): Promise<void>;
  /** Evaluate PHP with this file already required. `onOutput` takes the output away from the stdout mode. */
  $eval(code: string, onOutput?: (text: string) => void): Promise<any>;
  /** The underlying php-wasm instance. */
  $php(): Promise<PHP>;
  /** Drain output collected under `stdout: "capture"`. */
  $output(): string;
  /** What the parser found in this file. */
  readonly $meta: PhpModuleMeta;
}

/**
 * What an imported `.php` module can carry: `PhpRuntimeOptions` minus everything that cannot survive
 * `JSON.stringify` into generated source, and minus `isolation`, which `createPhpModule` refuses.
 */
export type PhpModuleRuntimeOptions = Omit<PhpRuntimeOptions, "loader" | "isolation" | "spawn"> & {
  /** Only `"refuse"`; a handler function cannot cross into generated source. */
  spawn?: "refuse";
};

export interface PhpPluginOptions {
  /** Write a sidecar `<file>.php.d.ts`. `"auto"` (default) writes only when not producing a bundle. */
  dts?: boolean | "auto";
  /** Default `"inherit"`. */
  stdout?: StdoutMode;
  /** Which files to handle. Default `/\.php$/`. */
  filter?: RegExp;
  /** Mount the project directory so sibling `require`s, `__DIR__` and Composer resolve. Default `true`.
   * `false` also drops the detected autoloader, which could not be reached without the mount. */
  mount?: boolean;
  /** File to require before the module. Defaults to a detected `vendor/autoload.php`; `false` disables. */
  autoload?: string | false;
  /** Interpreter options for every module this plugin loads. Must survive JSON; see the type. */
  runtime?: PhpModuleRuntimeOptions;
}

/** Versions with a `@php-wasm/node-X-Y` build package. */
export type PhpVersion = "8.0" | "8.1" | "8.2" | "8.3" | "8.4" | "8.5";

/** What `@php-wasm/node-X-Y` exports. */
export type PhpLoaderModule = PHPLoaderModule;

/** Supply a build php-wasm has no package for, or pin the jspi/asyncify variant. */
export type PhpLoader = () => Promise<PhpLoaderModule>;

export interface PhpMount {
  /** Absolute path on the host. */
  host: string;
  /** Where it appears inside the virtual filesystem. */
  at: string;
}

export interface PhpRuntimeOptions {
  /** Defaults to 8.5; anything else must be installed by the caller. */
  phpVersion?: PhpVersion;
  /** Takes precedence over `phpVersion`. */
  loader?: PhpLoader;
  /** `php.ini` entries applied before the first call. */
  ini?: Record<string, string | number>;
  /** `"refuse"` answers every spawn with a non-zero exit; a real handler gives guest code host execution. */
  spawn?: SpawnHandler | "refuse";
  /** Host directories to mount before the first call. */
  mounts?: readonly PhpMount[];
  /** Default deadline for `cli()`. In-process it only bounds waiting; under isolation it is a SIGKILL. */
  timeoutMs?: number;
  /** `"process"` runs every `cli()` in a child that exits afterwards. Options must then survive JSON. */
  isolation?: "process";
}

/** One filesystem/config step, replayed onto every fresh instance and shipped to isolation children. */
export type JournalOp =
  | { kind: "mount"; host: string; at: string }
  | { kind: "writeFile"; path: string; data: string; encoding: "utf8" | "base64" }
  | { kind: "mkdir"; path: string }
  | { kind: "ini"; entries: Record<string, string | number> };

export interface PhpCliOptions {
  env?: Record<string, string>;
  cwd?: string;
  /** Overrides the interpreter's own `timeoutMs`; `0` disables it. */
  timeoutMs?: number;
}

export interface PhpCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
