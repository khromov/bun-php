import { phpPlugin } from "./plugin";

export { phpPlugin } from "./plugin";
export { BunPHP, type BunPHPTag } from "./inline";
export { parsePhp } from "./parse";
export { resolveProject, type PhpProject } from "./project";
export { generateModule } from "./codegen";
export { generateDts } from "./dts";
export { PhpError, PhpFatalError, PhpParseError, PhpTimeoutError } from "./errors";
export { createInterpreter, PhpInterpreter } from "./interpreter";
export type { IsolationFailure, IsolationReply, IsolationRequest } from "./isolation";
export {
  bootPhp,
  nodeFsMountHandler,
  PHP_VERSION,
  PhpBuildLoadError,
  PhpBuildNotInstalledError,
} from "./php-runtime";
// Re-exported so reaching the interpreter through `$php()` needs no direct dependency on @php-wasm/universal.
export type { MountHandler, PHP, SpawnHandler } from "@php-wasm/universal";
export type {
  JournalOp,
  PhpArray,
  PhpCliOptions,
  PhpCliResult,
  PhpConstantMeta,
  PhpFunctionMeta,
  PhpLoader,
  PhpLoaderModule,
  PhpModuleApi,
  PhpModuleMeta,
  PhpModuleRuntimeOptions,
  PhpMount,
  PhpParamMeta,
  PhpPluginOptions,
  PhpRuntimeOptions,
  PhpValue,
  PhpVersion,
  StdoutMode,
} from "./types";

/** What `[serve.static] plugins = ["bun-php"]` picks up; use `phpPlugin()` to pass options. */
export default phpPlugin();
