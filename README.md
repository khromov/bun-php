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

## Can I do the meme thing?

Yes!

```php
import { BunPHP } from "bun-php";

await BunPHP`<?php echo "Hello, World!"; ?>`;

> Hello, World!
```

The original tweet:

![The original tweet](.github/images/screenshot.png)

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

await greet("world"); // "Hello, world!"
await greet("Bun", "Hey"); // "Hey, Bun!"
await addAll(1, 2, 3); // 6
GREETING; // "Hello" — a plain value, no await, no PHP boot
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

## Inline PHP

For a snippet that does not warrant a file, tag a template with `BunPHP`:

```ts
import { BunPHP } from "bun-php";

await BunPHP`<?php echo "Hello world";`; // prints "Hello world"
await BunPHP`<?php return 40 + 2;`; // 42
```

PHP prints for itself: `echo` reaches the terminal _as PHP writes it_, exactly
as it does from an imported `.php` file and from the PHP CLI — a long-running
script prints while it is still running rather than in one piece at the end.
The promise resolves to the value of a top-level `return`, or to `null` — PHP's
own answer for a closure that returns nothing — when there is no `return`.

To take that output as a value instead, use `BunPHP.capture`, which prints
nothing:

```ts
await BunPHP.capture`<?php echo "Hello world";`; // "Hello world"
await BunPHP.capture`<?php return 40 + 2;`; // 42, still — a return wins
await BunPHP.capture`<?php $unused = 1;`; // ""  — printed nothing
```

Tags behave as they do in a PHP file, where both are optional:

```ts
await BunPHP.capture`<?php echo "hi";`; // "hi"  — no closing tag
await BunPHP.capture`<?php echo "hi"; ?>`; // "hi"  — closing tag
await BunPHP`return 1 + 1;`; // 2     — no tags at all
await BunPHP.capture`<?= 6 * 7 ?>`; // "42"  — short echo
await BunPHP.capture`<p>a</p><?php echo "b";`; // "<p>a</p>b" — markup first
await BunPHP.capture`<?php echo "a"; ?><i>b</i>`; // "a<i>b</i>" — switching modes
```

A snippet with no tags at all is taken as PHP code rather than markup, since
that is what an inline snippet is for.

This is a plain runtime API, so unlike importing a `.php` file it needs no
plugin registration and no `preload` entry.

Interpolated values are converted to PHP **expressions**, never pasted in as
source, so a value can never be executed as code:

```ts
const name = "Bun";
await BunPHP`<?php return "Hello " . ${name} . "!";`; // "Hello Bun!"
await BunPHP`<?php return array_sum(${[1, 2, 3, 4]});`; // 10
```

Because they are expressions, they belong where an expression is valid rather
than inside a PHP string literal:

```ts
await BunPHP`<?php return "Hello " . ${name};`; // correct
await BunPHP`<?php return "Hello ${name}";`; // literal text, not the value
```

Snippets share one interpreter — `BunPHP` and `BunPHP.capture` use the same one
— and each runs as its own PHP request, so nothing leaks between them.
`BunPHP.dispose()` shuts it down.

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

| PHP              | TypeScript                                  |
| ---------------- | ------------------------------------------- |
| `int`, `float`   | `number`                                    |
| `string`         | `string`                                    |
| `bool`           | `boolean`                                   |
| `array`          | `PhpValue[] \| { [key: string]: PhpValue }` |
| `void`           | `void`                                      |
| `mixed`, no hint | `any`                                       |
| `?T`, `T\|null`  | `T \| null`                                 |
| `A\|B`           | `A \| B`                                    |
| a class name     | `Record<string, unknown>`                   |

Where a type hint is missing, `@param` / `@return` docblock tags are used
instead. A bare `array` hint also defers to the docblock, so
`@param float[] $values` on `function stats(array $values)` yields
`values: number[]`. Docblock summaries become JSDoc comments.

Not generating sidecars? Reference the fallback declaration instead, which
types every `.php` import as `any`:

```ts
/// <reference types="bun-php/types" />
```

## Multi-file projects and Composer

bun-php mounts the project directory into the WebAssembly filesystem, so
`require` of a sibling file, `__DIR__`, and Composer's autoloader all work:

```php
<?php
// app/report.php
use League\CommonMark\CommonMarkConverter;

require_once __DIR__ . '/helpers.php';

function report(string $markdown): string
{
    return (new CommonMarkConverter())->convert($markdown) . footer();
}
```

```ts
import { report } from "./app/report.php";
await report("# Title");
```

The project root is found by walking up from the `.php` file looking for
`vendor/autoload.php` or `composer.json`, the same way Composer resolves
context; failing that, the file's own directory is used. When a
`vendor/autoload.php` is found it is required before every call.

The mount is a live view of the host filesystem — files written after the
interpreter booted are visible, and PHP can write back to disk. See
[`demos/`](demos/) for real packages (CommonMark, Carbon, ramsey/uuid,
php-jwt, league/csv) exercised end to end.

Because each call is a fresh PHP request, the autoloader is re-registered every
time. Composer's autoloader is lazy, so this is cheap for packages you touch
lightly.

## Module API

The default export carries the interpreter controls:

```ts
import php from "./hello.php";

await php.$ready(); // boot without calling anything
await php.$eval("return PHP_VERSION;");
await php.$reset(); // discard all PHP state, keep the module
await php.$dispose(); // shut the interpreter down
const raw = await php.$php(); // the underlying php-wasm PHP instance
php.$meta; // what the parser found in this file
await php.call("greet", ["x"]); // call by name
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

| Option     | Default     | Meaning                                                                                               |
| ---------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `dts`      | `"auto"`    | Write sidecar types. `"auto"` writes unless producing a bundle.                                       |
| `stdout`   | `"inherit"` | Where PHP's `echo` output goes: `"inherit"`, `"capture"` (drain with `php.$output()`), or `"ignore"`. |
| `filter`   | `/\.php$/`  | Which files to handle.                                                                                |
| `mount`    | `true`      | Mount the project directory so sibling `require`s and Composer resolve.                               |
| `autoload` | auto        | Path to a file to require before each call. Auto-detects `vendor/autoload.php`; `false` disables.     |

Note that the `bun build` **CLI** cannot use plugins at all — use the
`Bun.build()` JS API, or `[serve.static] plugins = ["bun-php"]` for the dev
server.

## How it works

1. An `onLoad` hook intercepts `.php` imports.
2. [php-parser](https://github.com/glayzzle/php-parser) reads the file and
   collects its top-level functions and constants.
3. The plugin emits a JS module whose exports proxy into PHP.
4. On the first call, [php-wasm](https://github.com/WordPress/wordpress-playground)
   boots a PHP 8.5 interpreter and the project directory is mounted into its
   virtual filesystem. Later calls reuse that interpreter.
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
from one call to the next. The _interpreter_ is reused (that is what makes
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
- **Only the project directory is mounted.** A `require` pointing outside the
  detected root will not resolve. Set `mount: false` to opt out of mounting
  entirely, in which case only the imported file's own source is available.
- **No networking and no Xdebug.** The bundled extensions are those in the
  php-wasm build: `mbstring`, `openssl`, `hash`, `bcmath`, `dom`, `tokenizer`,
  `gd`, `zip`, `curl`, `sqlite3` and friends. Notably **`intl` is absent**, so
  packages requiring `ext-intl` will not load.
- **`function readonly()` does not parse.** PHP 8.5 itself allows `readonly`
  as a function name (an explicit exception in the keyword list), but
  php-parser — which powers the import pipeline — rejects it, so a file
  declaring one fails to import with a parse error.
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
