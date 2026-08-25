import { getPHPLoaderModule } from "@php-wasm/node-8-5";
import { PHP, loadPHPRuntime } from "@php-wasm/universal";

/**
 * The only module that touches `@php-wasm/*` directly.
 *
 * `@php-wasm/node-8-5` ships just the WebAssembly builds and a loader; the JS
 * API (`PHP`, `loadPHPRuntime`) lives in `@php-wasm/universal`. The convenience
 * adapter `@php-wasm/node` is deliberately not used: it statically imports
 * `fs-ext-extra-prebuilt`, a NAN native addon that throws at module-evaluation
 * time when its binding cannot load, and it depends on every per-version build
 * package. Going direct keeps the dependency tree pure JavaScript.
 *
 * Supporting further PHP versions means swapping the import above; nothing
 * else in the codebase needs to change.
 */
export const PHP_VERSION = "8.5";

/** Instantiate a fresh php-wasm runtime and return its id. */
export async function createRuntimeId(): Promise<number> {
  return loadPHPRuntime(await getPHPLoaderModule());
}

/** Boot a new PHP interpreter. */
export async function bootPhp(): Promise<PHP> {
  return new PHP(await createRuntimeId());
}
