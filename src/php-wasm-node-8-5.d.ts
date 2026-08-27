// `@php-wasm/node-8-5` ships no type declarations: only the PHP 8.5 WebAssembly builds and a loader.
declare module "@php-wasm/node-8-5" {
  import type { PHPLoaderModule } from "@php-wasm/universal";

  /** Resolve the PHP 8.5 build, picking JSPI or Asyncify for the host. */
  export function getPHPLoaderModule(): Promise<PHPLoaderModule>;
}
