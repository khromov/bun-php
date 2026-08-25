# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Bun plugin that makes `.php` files importable: `import { greet } from "./hello.php"` returns an async JS
function that calls into a PHP 8.5 interpreter running in WebAssembly (php-wasm). No PHP binary involved.
Published as the `bun-php` package; `src/` ships as-is (no build step — `exports` points straight at `.ts`).

## Commands

```bash
bun install
bun test                          # all tests
bun test test/parse.test.ts       # one file
bun test -t "variadic"            # one test by name
bun run example                   # example/index.ts against example/hello.php
bun run demos                     # demos/index.ts against real Composer packages
bun run typecheck                 # bunx tsc -p tsconfig.json (noEmit)

composer install --working-dir=demos   # required before demos/ runs or its tests
```

There is no lint step and no build step.

## Architecture

The pipeline runs once per imported `.php` file, at load time:

```
onLoad (plugin.ts)
  → parsePhp (parse.ts)      PHP source  → PhpModuleMeta
  → generateModule (codegen.ts)  meta    → JS module source, returned to Bun
  → generateDts (dts.ts)         meta    → sidecar <file>.php.d.ts written next to the source
  → resolveProject (project.ts)  path    → { root to mount, autoload to require }
```

The generated module imports `createPhpModule` from `runtime.ts` and exports one async wrapper per PHP
function. At call time: `runtime.ts` → `marshal.ts` (build the PHP script, decode the result) →
`php-runtime.ts` (the interpreter).

| File | Responsibility |
| --- | --- |
| `src/plugin.ts` | `onLoad` hook, option defaults, sidecar writing |
| `src/register.ts` | Side-effecting `plugin(phpPlugin())` for `preload` |
| `src/parse.ts` | php-parser AST → `PhpModuleMeta` (functions, constants, skip notes) |
| `src/php-types.ts` | PHP type hints and docblock types → TypeScript type expressions |
| `src/codegen.ts` | Emits the JS module |
| `src/dts.ts` | Emits the `.d.ts` sidecar |
| `src/runtime.ts` | Interpreter cache, lifecycle (`$ready`/`$reset`/`$dispose`), stdout modes |
| `src/inline.ts` | The `` BunPHP`...` `` tagged template for file-less snippets |
| `src/marshal.ts` | The JS ⇄ PHP call protocol |
| `src/project.ts` | Walks up from a `.php` file to find its Composer root and autoloader |
| `src/php-runtime.ts` | The only module importing `@php-wasm/*`, plus the NODEFS mount handler |
| `types/php.d.ts` | Fallback `*.php` module declaration for users not generating sidecars |

## Things that will bite you

**Registration must happen via `preload`.** ES module resolution beats `Bun.plugin()` called from the
importing file. `bunfig.toml` preloads `./src/register.ts` twice — once at top level, once under `[test]`,
because the top-level `preload` does not apply to `bun test`. The e2e tests depend on that second entry.

**Generated code imports the runtime by absolute path** (`RUNTIME_PATH` in `plugin.ts`), not by the
`bun-php/runtime` specifier, so it resolves the same whether bun-php is a dependency, a link, or this repo.

**Interpreters are cached on `globalThis`** (`__bunPhpInstances` in `runtime.ts`), not in a module variable —
`bun --hot` resets the module registry on every save and would otherwise leak an interpreter per edit. The
same reason drives the "skip the write if the content is unchanged" guard in `writeSidecar`: rewriting churns
mtime and retriggers the watcher in a loop.

**The call protocol is a JSON envelope between a sentinel pair**, not plain stdout parsing. PHP flushes open
output buffers to stdout on a fatal error, so the script's own `echo` output can land ahead of the envelope,
and user shutdown functions or destructors can print after it; `decodeOutput` parses the JSON between the
*last* sentinel pair and treats everything around it as script output. Any change to `buildCallScript` needs
the matching change in `decodeOutput`/`unwrapEnvelope`.

**Every call is a fresh PHP request.** `buildCallScript` re-`require_once`s the module each time because
php-wasm resets request-scoped state (declared functions included) between runs. That is also why `static`
variables and globals do not persist across calls — a documented limitation, and `test/e2e.test.ts` asserts it.

**The project directory is mounted, not copied.** `runtime.ts` mounts the resolved root over NODEFS, which
is a live view of the host FS — that is what makes sibling `require`, `__DIR__` and Composer work. The
inlined-source `writeFile` path is only a fallback for when the directory is not on disk (a bundle running
elsewhere). Mounts survive `hotSwapPHPRuntime`, so `$reset()` must *not* re-mount — hence the `#mounted` flag.

**Composer's autoloader is re-required on every call** (`buildCallScript`), because request state resets. This
is why `demos/` works at all, and why warm-call cost tracks how much the library does per call.

**The inline tag prints; `BunPHP.capture` returns.** `BunPHP` matches the plugin's `stdout: "inherit"`
default — `echo` goes to the terminal and the promise resolves to the top-level `return` (or `null`) — while
`BunPHP.capture` resolves to the output and prints nothing. Both share *one* interpreter, created with
`stdout: "capture"`: `runtime.ts` writes `inherit` output only once the request has finished, so having the
tag print the drained text is observably identical and avoids booting a second WebAssembly runtime. The drain
lives in a `finally`, or a snippet that throws mid-output would leave its text to surface inside the next one.

**Inline snippets interpolate as expressions, not text.** `src/inline.ts` runs every interpolated value
through `encodeValue()` from `marshal.ts`, so a value can never be executed as code (and `undefined`/BigInt
edge cases get named errors); `test/inline.test.ts` asserts that with real injection payloads. It also strips a leading open tag (the snippet is evaluated inside a closure) and
re-enters PHP mode when a snippet ends in markup, or the wrapper's closing brace becomes literal text.

**Aliasing has one source of truth.** `bindingNameFor` (exported from `codegen.ts`) decides the local binding
for a PHP name; `codegen.ts`, `dts.ts` and the uniqueness guard in `parse.ts` all call it so they cannot drift.
`parse.ts` also reserves the generated module's own identifiers (`__mod`, `createPhpModule`, `_default`,
`default`), skipping any PHP name that would collide — `define()` accepts names a `const` declaration cannot.
`RESERVED` in `codegen.ts` is *ECMAScript's* invalid-binding list (reserved words + strict-mode additions +
`arguments`/`eval`), not PHP's keyword list: `define()` can hand codegen any name at all. Beware that Bun's
transpiler tolerates the strict-mode-only subset (`implements`…`yield`) while its module loader rejects them,
so `Bun.Transpiler` alone is not proof a generated module loads — `test/e2e.test.ts` imports a `yield`
constant through the real loader for exactly that reason.

**Type-mapping changes** go in `php-types.ts` (`BUILTIN_TS` for declarations, `convertDocPart` for docblocks).
The precedence rule lives in `chooseType` in `parse.ts`: a real type declaration wins, *except* that bare
`array` and `mixed` defer to a `@param`/`@return` docblock tag.

**PHP version is a one-line change**: the `@php-wasm/node-8-5` import in `php-runtime.ts` plus the matching
dependency. `@php-wasm/node` is deliberately avoided — it statically imports a NAN native addon that throws at
module-evaluation time when its binding fails to load.

**Sidecar `.d.ts` files:** `test/fixtures/*.php.d.ts` and `demos/php/*.php.d.ts` are gitignored (regenerated
on the next run); `example/hello.php.d.ts` is committed on purpose as a worked example. `demos/vendor/` is
gitignored, `demos/composer.lock` is committed.

## Bun conventions

Default to Bun over Node.js: `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <pkg>`.
Prefer `Bun.file`/`Bun.write` over `node:fs` (test helpers use `node:fs/promises` for tmpdir work, which is
fine). Bun loads `.env` automatically — no dotenv. Bun API docs are in `node_modules/bun-types/docs/**.mdx`.
