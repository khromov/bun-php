import { phpPlugin } from "./plugin";

export { phpPlugin } from "./plugin";
export { BunPHP, type BunPHPTag } from "./inline";
export { parsePhp } from "./parse";
export { resolveProject, type PhpProject } from "./project";
export { generateModule } from "./codegen";
export { generateDts } from "./dts";
export { PhpError, PhpFatalError, PhpParseError, PhpTimeoutError } from "./errors";
export {
  createInterpreter,
  PhpInterpreter,
  type PhpCliOptions,
  type PhpCliResult,
  type PhpMount,
  type PhpRuntimeOptions,
} from "./interpreter";
export {
  bootPhp,
  nodeFsMountHandler,
  PHP_VERSION,
  PhpBuildNotInstalledError,
  type PhpLoader,
  type PhpLoaderModule,
  type PhpRuntimeSource,
  type PhpVersion,
} from "./php-runtime";
// Re-exported so reaching the interpreter through `$php()` does not force a
// direct dependency on @php-wasm/universal.
export type { MountHandler, PHP, SpawnHandler } from "@php-wasm/universal";
export type {
  PhpArray,
  PhpConstantMeta,
  PhpFunctionMeta,
  PhpModuleApi,
  PhpModuleMeta,
  PhpParamMeta,
  PhpPluginOptions,
  PhpValue,
  StdoutMode,
} from "./types";

/**
 * A ready-made plugin instance.
 *
 * This is what `[serve.static] plugins = ["bun-php"]` picks up; use the
 * `phpPlugin()` factory when you need to pass options.
 */
export default phpPlugin();
