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
bun run lint                      # oxlint (correctness rules)
bun run fmt                       # oxfmt, write in place
bun run fmt:check                 # oxfmt --check (what CI runs)

composer install --working-dir=demos   # required before demos/ runs or its tests
bun run demos:vendor:pack         # rebuild demos/vendor.zip (needs Composer; commit the result)
bun run demos:vendor:unpack       # unzip demos/vendor.zip into demos/vendor (what CI runs)
```

There is a lint step (oxlint + oxfmt) but no build step.

CI (`.github/workflows/test.yml`) runs on PRs and `main`: typecheck, lint, `fmt:check`, then unpacks
`demos/vendor.zip` and runs the tests on ubuntu + macos. The demo Composer deps are committed as
`demos/vendor.zip` (built by `demos:vendor:pack`) so CI needs neither Composer nor a system PHP —
regenerate and recommit that zip whenever `demos/composer.lock` changes. Releases go out via
`.github/workflows/release.yml`: release-please cuts the tag, then npm publishes over OIDC (no token).

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

| File                                           | Responsibility                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/plugin.ts`                                | `onLoad` hook, option defaults, sidecar writing                                               |
| `src/register.ts`                              | Side-effecting `plugin(phpPlugin())` for `preload`                                            |
| `src/parse.ts`                                 | php-parser AST → `PhpModuleMeta` (functions, constants, skip notes)                           |
| `src/php-types.ts`                             | PHP type hints and docblock types → TypeScript type expressions                               |
| `src/codegen.ts`                               | Emits the JS module                                                                           |
| `src/dts.ts`                                   | Emits the `.d.ts` sidecar                                                                     |
| `src/runtime.ts`                               | Interpreter cache, lifecycle (`$ready`/`$reset`/`$dispose`), stdout modes                     |
| `src/inline.ts`                                | The `` BunPHP`...` `` tagged template for file-less snippets                                  |
| `src/marshal.ts`                               | The JS ⇄ PHP call protocol                                                                    |
| `src/project.ts`                               | Walks up from a `.php` file to find its Composer root and autoloader                          |
| `src/php-runtime.ts`                           | The only module importing `@php-wasm/*`, the version→build map, plus the NODEFS mount handler |
| `src/interpreter.ts`                           | `createInterpreter` — a configured interpreter with no `.php` file behind it                  |
| `src/journal.ts`                               | Serializable filesystem/config ops, replayed on instance replacement and shipped to children  |
| `src/isolation.ts` + `src/isolation-runner.ts` | `isolation: "process"` — parent spawn/timeout half and the child entrypoint                   |
| `types/php.d.ts`                               | Fallback `*.php` module declaration for users not generating sidecars                         |

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
and user shutdown functions or destructors can print after it; the envelope is the JSON between the _last_
sentinel pair, and everything around it is script output. Any change to `buildCallScript` needs the matching
change in `EnvelopeSplitter`/`unwrapEnvelope`.

**Output is streamed, which is why `buildCallScript` does not `ob_start()`.** The script runs unbuffered
(`ob_implicit_flush(true)`) so `echo` reaches stdout as it happens, and `runtime.ts` reads `runStream()`'s
`response.stdout` chunk by chunk instead of awaiting `stdoutText` — a slow script prints while it is still
running. `EnvelopeSplitter` in `marshal.ts` does the classifying, which is harder than it is over a complete
string: a sentinel can straddle a chunk boundary (so a tail that could still grow into one is held back), a
sentinel pair whose contents are not JSON was never an envelope (so it is put back on the wire verbatim), and
_last pair wins_ means output after an envelope is held until the stream ends, in case a later one supersedes
it. `decodeOutput` is the same splitter fed a whole string, so the two cannot drift. Only buffers the _user's_
code opened and left open still arrive in the envelope's `out` field.

**Every call is a fresh PHP request.** `buildCallScript` re-`require_once`s the module each time because
php-wasm resets request-scoped state (declared functions included) between runs. That is also why `static`
variables and globals do not persist across calls — a documented limitation, and `test/e2e.test.ts` asserts it.

**The project directory is mounted, not copied.** `runtime.ts` mounts the resolved root over NODEFS, which
is a live view of the host FS — that is what makes sibling `require`, `__DIR__` and Composer work. The
inlined-source `writeFile` path is only a fallback for when the directory is not on disk (a bundle running
elsewhere). `$reset()`/`$dispose()` tear the runtime down with `php.exit()` rather than `hotSwapPHPRuntime`
(a hot swap would copy the old MEMFS across), so the next call re-boots and `#populate` re-mounts the root
from scratch — there is no mount to preserve.

**Composer's autoloader is re-required on every call** (`buildCallScript`), because request state resets. This
is why `demos/` works at all, and why warm-call cost tracks how much the library does per call.

**The inline tag prints; `BunPHP.capture` returns.** `BunPHP` matches the plugin's `stdout: "inherit"`
default — `echo` goes to the terminal as PHP writes it, and the promise resolves to the top-level `return`
(or `null`) — while `BunPHP.capture` resolves to the output and prints nothing. Both share _one_ interpreter,
created `"inherit"`: `capture` passes `$eval` an output sink, which overrides the instance's stdout mode for
that call alone. A sink rather than a shared buffer is what keeps a snippet that throws part-way through
printing from leaving its output behind for the next snippet — and it is the reason `capture` did not have to
cost a second WebAssembly runtime.

**Inline snippets interpolate as expressions, not text.** `src/inline.ts` runs every interpolated value
through `encodeValue()` from `marshal.ts`, so a value can never be executed as code (and `undefined`/BigInt
edge cases get named errors); `test/inline.test.ts` asserts that with real injection payloads. It also strips a leading open tag (the snippet is evaluated inside a closure) and
re-enters PHP mode when a snippet ends in markup, or the wrapper's closing brace becomes literal text.

**Aliasing has one source of truth.** `bindingNameFor` (exported from `codegen.ts`) decides the local binding
for a PHP name; `codegen.ts`, `dts.ts` and the uniqueness guard in `parse.ts` all call it so they cannot drift.
`parse.ts` also reserves the generated module's own identifiers (`__mod`, `createPhpModule`, `_default`,
`default`), skipping any PHP name that would collide — `define()` accepts names a `const` declaration cannot.
`RESERVED` in `codegen.ts` is _ECMAScript's_ invalid-binding list (reserved words + strict-mode additions +
`arguments`/`eval`), not PHP's keyword list: `define()` can hand codegen any name at all. Beware that Bun's
transpiler tolerates the strict-mode-only subset (`implements`…`yield`) while its module loader rejects them,
so `Bun.Transpiler` alone is not proof a generated module loads — `test/e2e.test.ts` imports a `yield`
constant through the real loader for exactly that reason.

**Type-mapping changes** go in `php-types.ts` (`BUILTIN_TS` for declarations, `convertDocPart` for docblocks).
The precedence rule lives in `chooseType` in `parse.ts`: a real type declaration wins, _except_ that bare
`array` and `mixed` defer to a `@param`/`@return` docblock tag.

**PHP version selection lives in `BUILD_PACKAGES` in `php-runtime.ts`**, a map from version to
`@php-wasm/node-X-Y` resolved with a dynamic `import()`. Only 8.5 is a real dependency; the rest are optional
peer dependencies, because each build is tens of MB of wasm. Adding an option that changes the interpreter
means adding it to the cache comparison in `createPhpModule` too — `runtimeKey()` covers the serialisable
options and `loader`/`spawn` are compared by identity, since without that a caller asking for a different PHP
version silently gets back the cached interpreter running the old one. `@php-wasm/node` is deliberately
avoided — it statically imports a NAN native addon that throws at module-evaluation time when its binding
fails to load.

**`PHP.cli()` consumes its instance.** It calls `exit()` on the runtime when the command finishes, and a
second `cli()` on the same instance returns exit code **-1 with no output and no error at all** — a silent
failure. `PhpInterpreter` therefore boots a replacement between commands and replays the journal
(`src/journal.ts`) onto it, which is why `mount`/`writeFile`/`mkdir`/`ini` record a `JournalOp` rather than
just acting. The ops are plain data on purpose: the same journal is what `isolation: "process"` ships to its
child, so the two mechanisms cannot drift. `replay` awaits `php()` _before_ recording, because `#boot`
replays the journal and recording first would run the new op twice on the very first call.

**Neither timeouts nor parallelism work the way you would assume in-process**, both measured:

- A running request cannot be interrupted. `PHP.exit()` mid-call returns without stopping it (a busy loop then
  ran to completion), and `max_execution_time` is ignored — a 2s limit let an 8s loop finish. So in-process
  `timeoutMs` bounds _waiting_ only: it rejects and retires the interpreter while the PHP keeps burning CPU.
  Say so wherever it is documented; a timeout that implies cancellation is worse than none.
- Interpreters do not overlap. Two concurrent 1s calls on two instances take ~2s (ratio 1.96), because the
  wasm holds the thread. That is why there is no pool API — a second interpreter in-process buys nothing, and
  `test/interpreter.test.ts` pins the ratio so nobody adds one on a hunch.

**`isolation: "process"` exists because of the previous paragraph**, plus one more measurement: the wasm heap
retains hundreds of MB across in-process boot/dispose cycles (35 MB baseline → 300–800 MB after a handful,
forced GC included) and the OS reclaiming an exited child is the only thing that returns it. Each `cli()`
spawns `src/isolation-runner.ts`, ships `{options, journal, argv}` as JSON, and SIGKILLs on timeout — so
under isolation `timeoutMs` really cancels, concurrent calls really overlap (1.04x measured), and a wasm
abort takes only the child. The constructor rejects `loader` and function-valued `spawn` up front because
they cannot cross the JSON boundary, `php()` throws for the same reason, and `createPhpModule` refuses
`runtime.isolation` outright — the imported-module path runs many small calls against one live instance,
the opposite shape. The runner deliberately constructs a plain in-process `PhpInterpreter`: the child _is_
the isolation, and reusing `#cli` keeps the two paths from diverging.

**Sidecar `.d.ts` files:** `test/fixtures/*.php.d.ts` and `demos/php/*.php.d.ts` are gitignored (regenerated
on the next run); `example/hello.php.d.ts` is committed on purpose as a worked example. `demos/vendor/` is
gitignored, `demos/composer.lock` is committed.

## Comments

Comment the **why**, never the what — the code already says what it does. Max **one sentence** per
comment; two only for a genuinely complex piece (a non-obvious constraint, a bug worked around, an
ordering dependency). Longer rationale belongs in this file or the README, not in the source. Prefer
no comment to an obvious one.

## Bun conventions

Default to Bun over Node.js: `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <pkg>`.
Prefer `Bun.file`/`Bun.write` over `node:fs` (test helpers use `node:fs/promises` for tmpdir work, which is
fine). Bun loads `.env` automatically — no dotenv. Bun API docs are in `node_modules/bun-types/docs/**.mdx`.
