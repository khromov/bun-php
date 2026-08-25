import { phpPlugin } from "./plugin";

export { phpPlugin } from "./plugin";
export { BunPHP, type BunPHPTag } from "./inline";
export { parsePhp } from "./parse";
export { resolveProject, type PhpProject } from "./project";
export { generateModule } from "./codegen";
export { generateDts } from "./dts";
export { PhpError, PhpFatalError, PhpParseError } from "./errors";
export { PHP_VERSION } from "./php-runtime";
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
