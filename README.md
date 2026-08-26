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

## Driving PHP directly

Importing a `.php` file suits calling library code. Driving a **PHP tool** —
a phar, a linter, a formatter — needs something else: an argument list, a
directory to work on that is only known at call time, and a `php.ini` that fits
the job. `createInterpreter` is that entry point. It involves no `.php` import,
no codegen and no `preload`:

```ts
import { createInterpreter } from "bun-php";

const php = createInterpreter({
  phpVersion: "8.3",
  spawn: "refuse",
  ini: { memory_limit: "1024M" },
});

await php.mount("/tmp/some-project", "/project");
const { stdout, exitCode } = await php.cli([
  "php",
  "/tools/phpcs.phar",
  "--report=json",
  "/project",
]);
```

| Option       | Default | Meaning                                                                                                                            |
| ------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `phpVersion` | `"8.5"` | Which build to boot. Anything else must be installed by you — see below.                                                           |
| `loader`     | –       | Supply the php-wasm build yourself. Takes precedence over `phpVersion`.                                                            |
| `ini`        | –       | `php.ini` entries, applied before the first call.                                                                                  |
| `spawn`      | –       | `"refuse"`, or your own handler. See the warning below.                                                                            |
| `mounts`     | –       | `{ host, at }` directories to mount up front.                                                                                      |
| `timeoutMs`  | –       | Deadline for `cli()`. In-process it bounds _waiting_, not the work — see Limitations. With `isolation: "process"` it is a SIGKILL. |
| `isolation`  | –       | `"process"` runs each `cli()` in a child process that exits afterwards.                                                            |

Beyond `cli()`, an interpreter offers `mount()`, `ini()`, `writeFile()`,
`mkdir()`, `php()` (the raw php-wasm instance) and `dispose()`.

### Process isolation

For a handful of calls the in-process interpreter is fine. For running a tool
across thousands of inputs it is not, for three measured reasons: the wasm heap
retains hundreds of MB across boot/dispose cycles and never returns to
baseline; a timeout cannot stop a running request, only abandon it; and two
interpreters cannot overlap, because the wasm work holds the thread.

`isolation: "process"` fixes all three at once by running every `cli()` in a
child process that exits when the call ends:

```ts
const php = createInterpreter({
  isolation: "process",
  phpVersion: "8.3",
  spawn: "refuse",
  ini: { memory_limit: "1024M" },
  timeoutMs: 600_000, // a real deadline: the child is SIGKILLed
});

await php.mount(exportDir, "/plugin");
await php.writeFile("/files.txt", list);
const { stdout, exitCode } = await php.cli(["php", "/tools/phpcs.phar", ...]);
```

`mount`/`writeFile`/`mkdir`/`ini` are recorded and replayed inside each child,
so the interpreter behaves identically — the same journal that makes a second
in-process `cli()` work is what crosses the process boundary. Measured across
ten calls, the parent's RSS moves by ~1 MB where the in-process equivalent
retains 300–800 MB; two concurrent one-second calls take 1.04× the time of one
rather than 1.96×; and a killed call leaves the interpreter usable, since the
dead child took the whole request with it.

The trade is that everything must survive JSON: `loader` and a function-valued
`spawn` are rejected at construction (`spawn: "refuse"` serializes fine), and
`php()` has no in-process instance to hand back. Each call also pays a child
spawn plus a fresh wasm boot — a few hundred milliseconds — which is noise for
a tool run and wrong for a hot loop of small calls.

The same options are accepted by the plugin, so an imported `.php` file can be
configured identically:

```ts
phpPlugin({ runtime: { phpVersion: "8.3", ini: { memory_limit: "512M" } } });
```

### Choosing a PHP version

`phpVersion` defaults to `8.5`, the only build bun-php depends on. Every other
version is an **optional peer dependency**, so you install the one you want:

```bash
bun add @php-wasm/node-8-3
```

Each build ships tens of megabytes of WebAssembly, which is why they are not all
bundled. Asking for one you have not installed names it rather than failing with
a bare module-resolution error:

```
PHP 8.1 needs @php-wasm/node-8-1, which is not installed.
Run `bun add @php-wasm/node-8-1`, or pass `loader` to supply the build yourself.
```

Each build picks the JSPI or asyncify variant for itself. `loader` is the way
past that when you need to pin one:

```ts
createInterpreter({
  loader: () => import("@php-wasm/node-8-3/asyncify/php_8_3.js"),
});
```

### Spawning

PHP's `exec`, `shell_exec` and `popen` reach the host through a spawn handler.
There is no default, and **leaving one uninstalled hangs the process**: a tool
that probes for a terminal with `shell_exec('tty')` — PHP_CodeSniffer does —
waits forever on a bridge that never answers.

`spawn: "refuse"` answers every spawn with an immediate non-zero exit, which is
what analysis tools want. Installing a _real_ handler that shells out gives any
PHP you run full host execution, so reach for it deliberately.

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

| Option     | Default     | Meaning                                                                                                        |
| ---------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `dts`      | `"auto"`    | Write sidecar types. `"auto"` writes unless producing a bundle.                                                |
| `stdout`   | `"inherit"` | Where PHP's `echo` output goes: `"inherit"`, `"capture"` (drain with `php.$output()`), or `"ignore"`.          |
| `filter`   | `/\.php$/`  | Which files to handle.                                                                                         |
| `mount`    | `true`      | Mount the project directory so sibling `require`s and Composer resolve.                                        |
| `autoload` | auto        | Path to a file to require before each call. Auto-detects `vendor/autoload.php`; `false` disables.              |
| `runtime`  | –           | `PhpRuntimeOptions` for the interpreter behind the module — see [Driving PHP directly](#driving-php-directly). |

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

**A running PHP request cannot be interrupted.** There is no way to cancel one
from JavaScript: `PHP.exit()` mid-call returns without stopping anything, and
`max_execution_time` is ignored by the wasm build — a script asking for a
two-second limit was measured running for the full eight seconds it was told to
burn. In-process, `timeoutMs` therefore rejects your promise and retires the
interpreter, but **the PHP keeps running**. The only real bound is a process you
can kill, which is exactly what `isolation: "process"` is: under it `timeoutMs`
SIGKILLs the child and the work actually stops.

**In-process interpreters do not run in parallel.** The wasm work holds the
thread, so two concurrent one-second calls on two separate interpreters take two
seconds, not one. There is deliberately no pool API, because a second
interpreter in the same process buys nothing. `isolation: "process"` is what
buys parallelism — each child runs on its own core — and it is also the
crash-safe shape, since a wasm abort is not catchable and takes its process
with it.

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
- **Mount scoping is the isolation that works.** Only what you mount exists
  inside the virtual filesystem, so an unmounted host path is simply not there.
  Do not reach for `open_basedir` or `disable_functions` as a substitute — their
  behaviour under php-wasm varies by build, and neither is load-bearing here.

## Development

```bash
bun install
bun test
bun run example
```

## License

MIT
