import type { PHP } from "@php-wasm/universal";

/** Any value that can cross the JS <-> PHP boundary (JSON-encodable). */
export type PhpValue =
  | string
  | number
  | boolean
  | null
  | PhpValue[]
  | { [key: string]: PhpValue };

/** A PHP `array`: a list when keys are sequential, an object otherwise. */
export type PhpArray = PhpValue[] | { [key: string]: PhpValue };

export interface PhpParamMeta {
  /** Parameter name, without the leading `$`. */
  name: string;
  /** TypeScript type expression for this parameter. */
  tsType: string;
  /** True when the parameter has a default value. */
  optional: boolean;
  variadic: boolean;
  /** `&$x`. Marshalling is by value, so writes are not reflected back. */
  byref: boolean;
}

export interface PhpFunctionMeta {
  /** The name exported to JavaScript (namespace-stripped). */
  exportName: string;
  /** The fully-qualified name used to call into PHP. */
  phpName: string;
  params: PhpParamMeta[];
  returnTsType: string;
  /** Summary line(s) from the docblock, if any. */
  doc: string | null;
}

export interface PhpConstantMeta {
  name: string;
  value: PhpValue;
}

export interface PhpModuleMeta {
  functions: PhpFunctionMeta[];
  constants: PhpConstantMeta[];
  /** Human-readable notes about declarations that could not be exported. */
  skipped: string[];
}

/** Where PHP's own `echo`/`print` output goes. */
export type StdoutMode = "inherit" | "capture" | "ignore";

export interface PhpModuleApi {
  /** Call a PHP function by its fully-qualified name. */
  call(name: string, args: readonly unknown[]): Promise<any>;
  /** Boot the interpreter without calling anything. */
  $ready(): Promise<void>;
  /** Tear down and re-boot the interpreter, discarding all PHP state. */
  $reset(): Promise<void>;
  /** Shut the interpreter down and drop it from the cache. */
  $dispose(): Promise<void>;
  /** Evaluate arbitrary PHP. The module's own file is already required. */
  $eval(code: string): Promise<any>;
  /** The underlying php-wasm instance, for escape-hatch use. */
  $php(): Promise<PHP>;
  /** Drain output collected under `stdout: "capture"`. */
  $output(): string;
  /** What the parser found in this file. */
  readonly $meta: PhpModuleMeta;
}

export interface PhpPluginOptions {
  /**
   * Write a sidecar `<file>.php.d.ts` next to each imported `.php` file.
   * `"auto"` (default) writes only when not producing a bundle.
   */
  dts?: boolean | "auto";
  /** Where PHP's `echo` output goes. Default `"inherit"`. */
  stdout?: StdoutMode;
  /** Which files to handle. Default `/\.php$/`. */
  filter?: RegExp;
  /**
   * Mount the project directory into the virtual filesystem so that sibling
   * `require`s, `__DIR__` and Composer packages resolve. Default `true`.
   */
  mount?: boolean;
  /**
   * Path to a PHP file to require before the module, typically a Composer
   * autoloader. Defaults to auto-detecting `vendor/autoload.php`; pass `false`
   * to disable.
   */
  autoload?: string | false;
}
