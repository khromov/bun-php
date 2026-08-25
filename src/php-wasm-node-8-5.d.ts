/**
 * `@php-wasm/node-8-5` ships no type declarations: it is a binaries-only
 * package holding the PHP 8.5 WebAssembly builds plus a small loader.
 */
declare module "@php-wasm/node-8-5" {
  import type { PHPLoaderModule } from "@php-wasm/universal";

  /** Resolve the PHP 8.5 build, picking JSPI or Asyncify for the host. */
  export function getPHPLoaderModule(): Promise<PHPLoaderModule>;

  export function getIntlExtensionPath(): Promise<string>;
  export function getXdebugExtensionPath(): Promise<string>;
  export function getRedisExtensionPath(): Promise<string>;
  export function getMemcachedExtensionPath(): Promise<string>;

  /** Whether the host supports the WebAssembly JavaScript Promise Integration. */
  export function jspi(): Promise<boolean>;
}
