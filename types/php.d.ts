/**
 * Fallback ambient declaration for `.php` imports.
 *
 * Reference this when you are not generating sidecar `<file>.php.d.ts` files:
 *
 *     /// <reference types="bun-php/types" />
 *
 * A generated sidecar always wins over this declaration, and gives real
 * parameter and return types instead of `any`.
 */
declare module "*.php" {
  const phpModule: {
    call(name: string, args: readonly unknown[]): Promise<any>;
    $ready(): Promise<void>;
    $reset(): Promise<void>;
    $dispose(): Promise<void>;
    $eval(code: string): Promise<any>;
    $php(): Promise<any>;
    $output(): string;
    $meta: {
      functions: readonly unknown[];
      constants: readonly unknown[];
      skipped: readonly string[];
    };
    [name: string]: any;
  };
  export default phpModule;
}
