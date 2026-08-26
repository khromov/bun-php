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

# The top-level `preload` does not apply to `bun test`, so repeat it here
# if your tests import .php files.
[test]
preload = ["bun-php/register"]
```

Registration must go through `preload`. Calling `Bun.plugin()` from the file
that imports the `.php` file is too late — module resolution runs before the
plugin registers.

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

Class methods, closures and arrow functions are ignored — only real top-level
functions are exported. A constant that needs PHP to evaluate it (say
`const C = 'a' . 'b';`) is skipped, and noted in a comment in the generated
module.

PHP function names that are JavaScript reserved words still work. They keep
their original name and can be imported with an alias:

```ts
import { delete as deleteFile } from "./files.php";
```

## Inline PHP

For a snippet that doesn't warrant a file, tag a template with `BunPHP`:

```ts
import { BunPHP } from "bun-php";

await BunPHP`<?php echo "Hello world";`; // prints "Hello world"
await BunPHP`<?php return 40 + 2;`; // 42
```

`BunPHP` prints as PHP runs: `echo` reaches the terminal as it happens, just
like an imported `.php` file or the PHP CLI. The promise resolves to a
top-level `return`, or to `null` when there is none.

Use `BunPHP.capture` to take the output as a value instead. It prints nothing:

```ts
await BunPHP.capture`<?php echo "Hello world";`; // "Hello world"
await BunPHP.capture`<?php return 40 + 2;`; // 42 — a return still wins
await BunPHP.capture`<?php $unused = 1;`; // "" — printed nothing
```

Tags are optional, exactly as in a PHP file:

```ts
await BunPHP.capture`<?php echo "hi";`; // "hi"  — no closing tag
await BunPHP.capture`<?php echo "hi"; ?>`; // "hi"  — closing tag
await BunPHP`return 1 + 1;`; // 2     — no tags at all
await BunPHP.capture`<?= 6 * 7 ?>`; // "42"  — short echo
await BunPHP.capture`<p>a</p><?php echo "b";`; // "<p>a</p>b" — markup first
await BunPHP.capture`<?php echo "a"; ?><i>b</i>`; // "a<i>b</i>" — mode switch
```

A tag-less snippet is read as PHP code, not markup — that's what inline
snippets are for.

Because it's a plain runtime API, inline PHP needs no plugin registration and
no `preload` entry.

Interpolated values are converted to PHP **expressions**, never pasted in as
source, so a value can never run as code:

```ts
const name = "Bun";
await BunPHP`<?php return "Hello " . ${name} . "!";`; // "Hello Bun!"
await BunPHP`<?php return array_sum(${[1, 2, 3, 4]});`; // 10
```

Being expressions, they go where an expression is valid, not inside a string
literal:

```ts
await BunPHP`<?php return "Hello " . ${name};`; // correct
await BunPHP`<?php return "Hello ${name}";`; // literal text, not the value
```

`BunPHP` and `BunPHP.capture` share one interpreter, and each snippet runs as
its own PHP request, so nothing leaks between them. `BunPHP.dispose()` shuts it
down.

## Types

The plugin writes a sidecar `hello.php.d.ts` next to each `.php` file, derived
from the PHP type declarations:

```ts
export declare function greet(name: string, greeting?: string): Promise<string>;
export declare function addAll(...numbers: number[]): Promise<number>;
export declare const GREETING: "Hello";
```

TypeScript picks these up automatically for `import ... from "./hello.php"`, so
you get autocomplete and type errors. Commit the sidecars or add `*.php.d.ts`
to `.gitignore` — either works.

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

When a type hint is missing, `@param` / `@return` docblock tags are used
instead. A bare `array` hint also defers to the docblock, so
`@param float[] $values` on `function stats(array $values)` yields
`values: number[]`. Docblock summaries become JSDoc comments.

Not generating sidecars? Reference the fallback declaration, which types every
`.php` import as `any`:

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
`vendor/autoload.php` or `composer.json` (the file's own directory is the
fallback). When a `vendor/autoload.php` is found it is required before every
call.

The mount is a live view of the host filesystem — files written after the
interpreter booted are visible, and PHP can write back to disk. See
[`demos/`](demos/) for real packages (CommonMark, Carbon, ramsey/uuid,
php-jwt, league/csv) exercised end to end.

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

Importing a `.php` file is for calling library code. Driving a PHP **tool** —
a phar, a linter, a formatter — needs an argument list, a directory only known
at call time, and a fitting `php.ini`. That's what `createInterpreter` is for.
It involves no `.php` import, no codegen and no `preload`:

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

| Option       | Default | Meaning                                                                                                             |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `phpVersion` | `"8.5"` | Which build to boot. Any other version must be installed by you — see below.                                        |
| `loader`     | –       | Supply the php-wasm build yourself. Takes precedence over `phpVersion`.                                             |
| `ini`        | –       | `php.ini` entries, applied before the first call.                                                                   |
| `spawn`      | –       | `"refuse"`, or your own handler. See the warning below.                                                             |
| `mounts`     | –       | `{ host, at }` directories to mount up front.                                                                       |
| `timeoutMs`  | –       | Deadline for `cli()`. In-process it bounds waiting, not the work (see Limitations); under isolation it's a SIGKILL. |
| `isolation`  | –       | `"process"` runs each `cli()` in a child process that exits afterwards.                                             |

Beyond `cli()`, an interpreter offers `mount()`, `ini()`, `writeFile()`,
`mkdir()`, `php()` (the raw php-wasm instance) and `dispose()`.

### Process isolation

The in-process interpreter is fine for a handful of calls. For running a tool
across thousands of inputs, `isolation: "process"` runs every `cli()` in a
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

It fixes three things the in-process interpreter can't:

- **Memory returns to baseline.** The wasm heap retains hundreds of MB across
  boot/dispose cycles in-process; an exiting child hands it back to the OS.
  Across ten calls the parent's RSS moves ~1 MB versus 300–800 MB in-process.
- **`timeoutMs` actually cancels.** In-process a timeout only abandons the
  request; here it SIGKILLs the child and the work stops.
- **Calls run in parallel.** Two concurrent one-second calls take 1.04× the
  time of one, versus 1.96× in-process.

`mount`/`writeFile`/`mkdir`/`ini` are recorded and replayed inside each child,
so it behaves identically. Everything must survive JSON, though: `loader` and a
function-valued `spawn` are rejected at construction (`spawn: "refuse"` is
fine), and `php()` has no instance to return. Each call also pays a child spawn
plus a fresh wasm boot (a few hundred milliseconds) — noise for a tool run,
wrong for a hot loop of small calls.

The plugin accepts the same options, so an imported `.php` file can be
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

Each build is tens of megabytes of WebAssembly, which is why they aren't all
bundled. Asking for one you haven't installed tells you which package to add:

```
PHP 8.1 needs @php-wasm/node-8-1, which is not installed.
Run `bun add @php-wasm/node-8-1`, or pass `loader` to supply the build yourself.
```

Each build picks the JSPI or asyncify variant itself. Use `loader` to pin one:

```ts
createInterpreter({
  loader: () => import("@php-wasm/node-8-3/asyncify/php_8_3.js"),
});
```

### Spawning

PHP's `exec`, `shell_exec` and `popen` reach the host through a spawn handler.
There is no default, and **leaving one uninstalled hangs the process**: a tool
that probes for a terminal with `shell_exec('tty')` — PHP_CodeSniffer does —
waits forever for an answer that never comes.

`spawn: "refuse"` answers every spawn with an immediate non-zero exit, which is
what analysis tools want. A real handler that shells out gives any PHP you run
full host execution, so install one deliberately.

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

The `bun build` **CLI** can't use plugins at all — use the `Bun.build()` JS
API, or `[serve.static] plugins = ["bun-php"]` for the dev server.

## How it works

1. An `onLoad` hook intercepts `.php` imports.
2. [php-parser](https://github.com/glayzzle/php-parser) reads the file and
   collects its top-level functions and constants.
3. The plugin emits a JS module whose exports proxy into PHP.
4. On the first call, [php-wasm](https://github.com/WordPress/wordpress-playground)
   boots a PHP 8.5 interpreter and mounts the project directory into its virtual
   filesystem; later calls reuse it.
5. Arguments and return values cross as JSON. PHP's own output is captured
   separately so it can never corrupt the result.

## Limitations

**Each call is an isolated PHP request.** php-wasm resets request-scoped state
between runs, so `static` variables, globals and superglobals don't carry over.
The interpreter is reused (that's what makes calls fast), but PHP userland state
is not.

```php
function tick(): int { static $n = 0; return ++$n; }
```

```ts
await tick(); // 1
await tick(); // 1, not 2
```

Use `$eval` or module-level PHP for state within a single call, or keep state on
the JavaScript side.

**A running PHP request can't be interrupted.** `PHP.exit()` mid-call returns
without stopping anything, and `max_execution_time` is ignored by the wasm
build. In-process, `timeoutMs` rejects your promise and retires the interpreter,
but the PHP keeps running. To actually stop it, use `isolation: "process"`,
where `timeoutMs` SIGKILLs the child.

**In-process interpreters don't run in parallel.** The wasm work holds the
thread, so two concurrent one-second calls take two seconds. There's no pool
API on purpose — a second in-process interpreter buys nothing.
`isolation: "process"` is what gives you parallelism, and it's crash-safe too:
an uncatchable wasm abort takes only its own child.

**Other things to know:**

- **ESM only.** `.php` modules can't be loaded with `require()`.
- **Values cross by JSON.** Integers beyond `Number.MAX_SAFE_INTEGER` lose
  precision; resources and closures can't be returned; objects arrive as their
  public properties. PHP list arrays become JS arrays, associative arrays become
  objects, and JS objects arrive in PHP as associative arrays (not `stdClass`).
- **By-reference parameters (`&$x`) don't write back.** Arguments pass by value;
  the generated types carry a JSDoc warning.
- **Only the project directory is mounted.** A `require` pointing outside the
  detected root won't resolve. Set `mount: false` to opt out, leaving only the
  imported file's own source.
- **No networking and no Xdebug.** Available extensions are whatever the php-wasm
  build ships: `mbstring`, `openssl`, `hash`, `bcmath`, `dom`, `tokenizer`,
  `gd`, `zip`, `curl`, `sqlite3` and friends. **`intl` is absent**, so packages
  requiring `ext-intl` won't load.
- **`function readonly()` doesn't parse.** PHP 8.5 allows `readonly` as a
  function name, but php-parser rejects it, so a file declaring one fails to
  import.
- **Only what you mount exists** inside the virtual filesystem — an unmounted
  host path simply isn't there. Don't reach for `open_basedir` or
  `disable_functions` as a substitute; their behaviour under php-wasm varies by
  build.

## Development

```bash
bun install
bun test
bun run example
```

## License

MIT
