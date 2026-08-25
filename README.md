# bun-php

Import `.php` files into Bun and call PHP functions as async JavaScript functions.

```php
<?php
// hello.php
function greet(string $name): string
{
    return "Hello, $name!";
}
```

```ts
import { greet } from "./hello.php";

console.log(await greet("world")); // "Hello, world!"
```

No PHP binary required — PHP 8.5 runs inside WebAssembly.

## Install

```bash
bun add bun-php
```

Then register the plugin in `bunfig.toml`:

```toml
preload = ["bun-php/register"]

# The top-level `preload` is not applied to `bun test`, so repeat it here
# if your tests import .php files.
[test]
preload = ["bun-php/register"]
```

Registration has to happen through `preload`. Calling `Bun.plugin()` from the
same file that imports a `.php` file does not work, because ES module
resolution happens before the plugin registers.

## What gets exported

Every top-level `function` becomes an async JavaScript function, and every
top-level constant with a literal value becomes a plain exported value.

```php
<?php
const GREETING = 'Hello';

function greet(string $name, string $greeting = GREETING): string
{
    return "$greeting, $name!";
}

function addAll(int ...$numbers): int
{
    return array_sum($numbers);
}
```

```ts
import phpModule, { greet, addAll, GREETING } from "./hello.php";

await greet("world");        // "Hello, world!"
await greet("Bun", "Hey");   // "Hey, Bun!"
await addAll(1, 2, 3);       // 6
GREETING;                    // "Hello" — a plain value, no await, no PHP boot
```

Class methods, closures and arrow functions are ignored; only real top-level
functions are exported. A constant whose value needs PHP to evaluate it (say
`const C = 'a' . 'b';`) is skipped and listed in a comment in the generated
module.

PHP function names that are JavaScript reserved words still work — they are
exported under their original name and can be imported with an alias:

```ts
import { delete as deleteFile } from "./files.php";
```

## Types

The plugin writes a sidecar `hello.php.d.ts` next to each `.php` file, derived
from the PHP type declarations:

```ts
export declare function greet(name: string, greeting?: string): Promise<string>;
export declare function addAll(...numbers: number[]): Promise<number>;
export declare const GREETING: "Hello";
```

TypeScript picks this up automatically for `import ... from "./hello.php"`, so
you get real autocomplete and type errors. Commit the sidecars or add
`*.php.d.ts` to `.gitignore` — either works.

| PHP | TypeScript |
| --- | --- |
| `int`, `float` | `number` |
| `string` | `string` |
| `bool` | `boolean` |
| `array` | `PhpValue[] \| { [key: string]: PhpValue }` |
| `void` | `void` |
| `mixed`, no hint | `any` |
| `?T`, `T\|null` | `T \| null` |
| `A\|B` | `A \| B` |
| a class name | `Record<string, unknown>` |

Where a type hint is missing, `@param` / `@return` docblock tags are used
instead. A bare `array` hint also defers to the docblock, so
`@param float[] $values` on `function stats(array $values)` yields
`values: number[]`. Docblock summaries become JSDoc comments.

Not generating sidecars? Reference the fallback declaration instead, which
types every `.php` import as `any`:

```ts
/// <reference types="bun-php/types" />
```

## Module API

The default export carries the interpreter controls:

```ts
import php from "./hello.php";

await php.$ready();              // boot without calling anything
await php.$eval("return PHP_VERSION;");
await php.$reset();              // discard all PHP state, keep the module
await php.$dispose();            // shut the interpreter down
const raw = await php.$php();    // the underlying php-wasm PHP instance
php.$meta;                       // what the parser found in this file
await php.call("greet", ["x"]);  // call by name
```

## Plugin options

```ts
import { phpPlugin } from "bun-php";

Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "bun",
  plugins: [phpPlugin({ stdout: "capture" })],
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `dts` | `"auto"` | Write sidecar types. `"auto"` writes unless producing a bundle. |
| `stdout` | `"inherit"` | Where PHP's `echo` output goes: `"inherit"`, `"capture"` (drain with `php.$output()`), or `"ignore"`. |
| `filter` | `/\.php$/` | Which files to handle. |

Note that the `bun build` **CLI** cannot use plugins at all — use the
`Bun.build()` JS API, or `[serve.static] plugins = ["bun-php"]` for the dev
server.

## How it works

1. An `onLoad` hook intercepts `.php` imports.
2. [php-parser](https://github.com/glayzzle/php-parser) reads the file and
   collects its top-level functions and constants.
3. The plugin emits a JS module whose exports proxy into PHP.
4. On the first call, [php-wasm](https://github.com/WordPress/wordpress-playground)
   boots a PHP 8.5 interpreter (~120 ms) and the file is written to its virtual
   filesystem. Later calls reuse that interpreter (~1 ms each).
5. Arguments are base64-JSON encoded into a generated PHP snippet; the return
   value comes back as JSON. PHP's own output is captured separately so it can
   never corrupt the result.

The runtime is `@php-wasm/universal` plus `@php-wasm/node-8-5` directly, rather
than the `@php-wasm/node` convenience adapter. That adapter statically imports
a NAN native addon which throws at module-evaluation time when its binding
cannot load, and it depends on every per-version build package. Going direct
keeps the dependency tree pure JavaScript, and Bun 1.4 selects the faster JSPI
build automatically.

## Limitations

**Each call is an isolated PHP request.** php-wasm resets request-scoped state
between runs, so `static` variables, globals and superglobals do not carry over
from one call to the next. The *interpreter* is reused (that is what makes
calls fast), but PHP userland state is not.

```php
function tick(): int { static $n = 0; return ++$n; }
```

```ts
await tick(); // 1
await tick(); // 1, not 2
```

Use `$eval` or module-level PHP if you need state within a single call, or keep
state on the JavaScript side.

**Other things to know:**

- **ESM only.** `.php` modules cannot be loaded with `require()`.
- **Values cross by JSON.** Integers beyond `Number.MAX_SAFE_INTEGER` lose
  precision; resources and closures cannot be returned; objects arrive as their
  public properties. PHP list arrays become JS arrays, associative arrays become
  objects, and JS objects arrive in PHP as associative arrays (not `stdClass`).
- **By-reference parameters (`&$x`) do not write back.** Arguments are passed by
  value; the generated types carry a JSDoc warning.
- **Only the imported file is on the virtual filesystem.** `require` of a
  sibling file will not resolve. Write extra files in yourself first:

  ```ts
  const raw = await php.$php();
  raw.writeFile("/path/to/helper.php", await Bun.file("./helper.php").text());
  ```

- **No Composer or autoloading**, no networking, no Xdebug.
- **PHP 8.5 only.** The runtime import is isolated in `src/php-runtime.ts`, so
  supporting other versions is a one-line change plus the matching
  `@php-wasm/node-X-Y` dependency.

## Development

```bash
bun install
bun test
bun run example
```

## License

MIT
