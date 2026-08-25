/**
 * Fallback ambient declaration for `.php` imports.
 *
 * Reference this when you are not generating sidecar `<file>.php.d.ts` files:
 *
 *     /// <reference types="bun-php/types" />
 *
 * The shorthand form is deliberate: it types *every* import from a `.php`
 * file — named and default alike — as `any`. A declaration body could give the
 * default export a precise shape, but would reject named imports entirely.
 * A generated sidecar always wins over this declaration, and gives real
 * parameter and return types instead of `any`.
 */
declare module "*.php";
