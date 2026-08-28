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
`interpreter.ts` → `php-runtime.ts` (the interpreter).

| File                                           | Responsibility                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/plugin.ts`                                | `onLoad` hook, option defaults, sidecar writing                                                      |
| `src/register.ts`                              | Side-effecting `plugin(phpPlugin())` for `preload`                                                   |
| `src/parse.ts`                                 | php-parser AST → `PhpModuleMeta` (functions, constants, skip notes)                                  |
| `src/php-types.ts`                             | PHP type hints and docblock types → TypeScript type expressions                                      |
| `src/codegen.ts`                               | Emits the JS module; owns the aliasing helpers (`bindingNameFor`, `exportLines`) dts.ts shares       |
| `src/dts.ts`                                   | Emits the `.d.ts` sidecar                                                                            |
| `src/runtime.ts`                               | `PhpInstance` (a `PhpInterpreter` plus call streaming, stdout modes, the `--hot` cache) and `$`-API  |
| `src/inline.ts`                                | The `` BunPHP`...` `` tagged template for file-less snippets                                         |
| `src/marshal.ts`                               | The JS ⇄ PHP call protocol                                                                           |
| `src/project.ts`                               | Walks up from a `.php` file to find its Composer root and autoloader                                 |
| `src/php-runtime.ts`                           | The only module that _calls_ `@php-wasm/*`: version→build map, `bootPhp`, journal ops, mount handler |
| `src/interpreter.ts`                           | `PhpInterpreter` — lazy boot, journal, `cli()`, timeouts, and the `isolation: "process"` dispatch    |
| `src/isolation.ts` + `src/isolation-runner.ts` | `isolation: "process"` — parent spawn/timeout half and the child entrypoint                          |
| `src/types.ts`                                 | Every public type, so no module imports another in a cycle                                           |
| `types/php.d.ts`                               | Fallback `*.php` module declaration for users not generating sidecars                                |

## Things that will bite you

**Registration must happen via `preload`.** ES module resolution beats `Bun.plugin()` called from the
importing file. `bunfig.toml` preloads `./src/register.ts` twice — once at top level, once under `[test]`,
because the top-level `preload` does not apply to `bun test`. The e2e tests depend on that second entry.

**Generated code imports the runtime by absolute path** (`RUNTIME_PATH` in `plugin.ts`), not by the
`bun-php/runtime` specifier, so it resolves the same whether bun-php is a dependency, a link, or this repo.

**Interpreters are cached on `globalThis`** (`__bunPhpInstances` in `runtime.ts`), not in a module variable —
`bun --hot` resets the module registry on every save and would otherwise leak an interpreter per edit. The
cache key is `JSON.stringify` of everything serialisable (source, stdout mode, root, autoload, runtime
options); `loader` and `spawn` are functions and are compared by identity. Anything new that changes which
interpreter to boot must land in that key, or a caller asking for it silently gets the cached one. The same
`--hot` concern drives the "skip the write if the content is unchanged" guard in `writeSidecar`: rewriting
churns mtime and retriggers the watcher in a loop.

**An autoloader is only ever required when the root is mounted.** `plugin.ts` passes `autoload: false` to
`resolveProject` when `mount: false`, and `PhpInstance` drops the autoload path whenever it takes the
mkdir+writeFile fallback instead of mounting — a `require_once` of a host path that is not in the virtual
filesystem is an `E_COMPILE_ERROR` on _every_ call, not just the first. An explicitly configured
`autoload: "<path>"` still survives `mount: false`; only detection is switched off.

**One journal configures every instance.** A `JournalOp` (`php-runtime.ts`) is plain data: mount, mkdir,
writeFile, ini. `PhpInterpreter` turns its `ini`/`mounts` options into journal ops at construction and
`bootPhp(options, ops)` replays them onto every fresh instance, so there is no separate "apply options" step
to drift from it. `PhpInstance` seeds its interpreter's journal with either a mount of the project root or —
when the _module file_ is not on disk, a bundle running elsewhere — a mkdir plus writeFile of the inlined
source. The gate is the file, not the directory: a root that exists without the file mounts happily and
then fatals on the `require_once` of every call. The same journal is what `isolation: "process"` ships to its child.

**`PHP.cli()` consumes its instance.** It calls `exit()` on the runtime when the command finishes, and a
second `cli()` on the same instance returns exit code **-1 with no output and no error at all**. So `#cli`
takes the boot promise and sets `#instance` to `null` _before_ awaiting it; the next `cli()` (or `mount()`)
boots a replacement and replays the journal. `#apply` awaits `php()` _before_ recording an op, because a
boot replays the journal and recording first would run the new op twice on the very first call.

**A journal op is recorded only once it has applied.** `#apply` boots first (a boot replays the journal, so
recording first would run the op twice) and pushes only after `applyOp` resolves. Pushing first meant a
`mount()` that rejected still replayed onto every later boot: the caller was told it failed while it broke
every subsequent `cli()` with an opaque error.

**In-process `timeoutMs` bounds waiting, wherever it is set.** `withDeadline` in `interpreter.ts` is the
one implementation: `PhpInterpreter` uses it for `cli()` and sets `retired`, and `PhpInstance.run` uses it
for module calls, where there is no flag to set and later calls simply queue behind the abandoned request.
A module's `timeoutMs` used to be accepted, documented and silently ignored. The deadline is armed _after_
`php()` resolves, so a cold call does not spend its budget on a boot the caller cannot influence; the same
reason `killedByDeadline` in `isolation.ts` requires a `signalCode`, because a timer firing as the child
exits kills a corpse and would otherwise discard the complete reply it left in stdout.

**A rejected boot is not cached.** `php()` clears `#instance` when `bootPhp` rejects, so a transient
failure does not replay on every later call until `$reset()`. `dispose()` clears `retired` for the same
reason: the replacement instance is nobody's abandoned request.

**`$reset()` and `$dispose()` are lazy.** Both wait for in-flight calls (`#running`), then `dispose()` the
interpreter; `reset()` clears the captured buffer _after_ that drain, or a call finishing during it refills
the buffer past the reset. the next call re-boots and the journal re-mounts the root from scratch. That is why
php-wasm's `hotSwapPHPRuntime` is not used — a hot swap would copy the old MEMFS across, and `$reset` exists
to discard it. `$dispose` also drops the cache entry, but only while it still points at this instance, so
disposing a stale `--hot` handle does not evict its replacement.

**The call protocol is a JSON envelope between a sentinel pair**, not plain stdout parsing. PHP flushes open
output buffers to stdout on a fatal error, so the script's own `echo` output can land ahead of the envelope,
and user shutdown functions or destructors can print after it; the envelope is the JSON between the _last_
sentinel pair, and everything around it is script output. Any change to `buildCallScript` needs the matching
change in `EnvelopeSplitter`/`unwrapEnvelope`.

**Output is streamed, which is why `buildCallScript` does not `ob_start()`.** The script runs unbuffered
(`ob_implicit_flush(true)`) so `echo` reaches stdout as it happens, and `runtime.ts` reads `runStream()`'s
`response.stdout` chunk by chunk instead of awaiting `stdoutText`. `EnvelopeSplitter` in `marshal.ts` does the
classifying: a sentinel can straddle a chunk boundary (so a tail that could still grow into one is held
back), a sentinel pair whose contents are not JSON was never an envelope (so it is put back verbatim), and
_last pair wins_ means output after an envelope is held until the stream ends, in case a later one supersedes
it. `test/marshal.test.ts` feeds the splitter whole strings and chunk-by-chunk, so the two cannot drift.
A failed pair puts back only its _opening_ sentinel and stays in-envelope, so the closing one becomes the
next opener: otherwise one stray sentinel in the script's output shifts the pairing by one and the real
envelope is emitted as text.
Only buffers the _user's_ code opened and left open still arrive in the envelope's `out` field, and
`end()` releases them before the output held after the envelope, because PHP wrote them first.

**Values cross by JSON, so `NaN`/`Infinity` only survive as a whole argument.** `encodeValue` turns a
top-level one into PHP's `NAN`/`INF`, but `phpVar` encodes anything else through JSON, where they become
`null`; `nonFinitePath` finds a nested one and throws instead of losing it silently — it carries a `WeakSet`,
because a cycle would otherwise blow the stack before `phpVar` could report it as an encoding failure.
Nested `undefined` is deliberately _not_ in that rule: it follows JSON, becoming `null` in an array and a
dropped key in an object, which is what JavaScript callers already expect. `encodeArgs` builds its
list by index rather than `.map`, which skips array holes and used to emit the invalid `f(, 1)`.

**Every call is a fresh PHP request.** `buildCallScript` re-`require_once`s the module and the Composer
autoloader each time because php-wasm resets request-scoped state (declared functions and autoloaders
included) between runs. That is also why `static` variables and globals do not persist across calls — a
documented limitation, and `test/e2e.test.ts` asserts it.

**Calls on one instance never overlap, and nothing in bun-php queues them.** php-wasm's `runStream` holds a
concurrency-1 semaphore until the request finishes, and every response has its own stdout stream. That is
why `inline.ts` has no task queue and `PhpInstance` has no lifecycle serialiser: `test/inline.test.ts`
fires twelve concurrent captures and asserts their outputs and return values stay separate.

**The inline tag prints; `BunPHP.capture` returns.** `BunPHP` matches the plugin's `stdout: "inherit"`
default, while `BunPHP.capture` resolves to the output and prints nothing. Both share _one_ interpreter,
created `"inherit"`: `capture` passes `$eval` an output sink, which overrides the instance's stdout mode for
that call alone. A sink per call is what keeps a snippet that throws part-way through printing from leaving
its output behind for the next snippet.

**Inline snippets are read from `strings.raw`, not the cooked segments.** The snippet is PHP source, and
cooked strings let JavaScript consume its escapes first: `preg_match('/\d+/')` silently became `/d+/`, a
leading `\` on a class name disappeared, and an invalid escape made the segment `undefined`, which `?? ""`
turned into an erased snippet returning `null`. Raw segments are never `undefined`, so both go away together.
The cost is that a template's `\n` is now PHP's escape rather than JavaScript's; write real newlines.

**Inline snippets interpolate as expressions, not text.** `src/inline.ts` runs every interpolated value
through `encodeValue()` from `marshal.ts`, so a value can never be executed as code; `test/inline.test.ts`
asserts that with real injection payloads. `asClosureBody` strips a leading open tag (the snippet is
evaluated inside a closure) and re-enters PHP mode when a snippet ends in markup, or the wrapper's closing
brace becomes literal text. Which tags are real is decided by `scanMode`, which runs php-parser's lexer
(`tokenGetAll`), not `includes`/`lastIndexOf`: a `<?` or `?>` inside a string literal, heredoc/nowdoc or
block comment is not a tag, while one inside a `//`/`#` line comment _is_ a real close, exactly as PHP reads
it. `tokenGetAll` has no eval mode (the `mode_eval` lexer option does not reach it), so the snippet gets a
`<?php ` prefix to start the lexer in code mode, and a `<` token immediately followed by `?` is what marks a
snippet that meant to open with markup — no valid PHP puts those two adjacent. That makes `inline.ts` the
second consumer of php-parser after `parse.ts`; do not hand-roll the scan back. `asClosureBody` is exported
so `test/inline.test.ts` can unit-test the rules without booting wasm. Both Engines pass
`lexer: { short_tags: true }` (the option is `short_tags`, not `short_open_tag`) because the php-wasm build
ships PHP's built-in `short_open_tag=On`: with the parser disagreeing, a `<?` file exported nothing and a
`<?` snippet got a `<?php ` re-entry appended while PHP was already in code mode.

**Aliasing has one source of truth.** `bindingNameFor` (exported from `codegen.ts`) decides the local binding
for a PHP name, and `exportLines` turns that into either a direct export or an alias plus re-export;
`codegen.ts`, `dts.ts` and the uniqueness guard in `parse.ts` all go through them so they cannot drift.
`parse.ts` also reserves the generated module's own identifiers (`__mod`, `createPhpModule`, `_default`,
`default`), skipping any PHP name that would collide — `define()` accepts names a `const` declaration cannot.
Separately, `API_NAME` in `codegen.ts` is the one name (`call`) a PHP function shares with the module
API: the function stays a named export, but `dts.ts` leaves it off the `_default` block and both
generators emit a "Named export only" trailer, because a second `call` key is a TS2717 and at runtime the
API wins anyway — which is why `createPhpModule` lists `call` _after_ the function spread. Every other API
member is `$`-prefixed and a PHP function name cannot start with `$`, so `call` is the whole list.
A constant whose value JavaScript cannot reproduce faithfully is `NOT_LITERAL` rather than a guess: an
array key past 2^53 (rounding it collides two entries or restarts the implicit key at zero), and an
implicit key following a negative one, which PHP 8.3 resumes at `-4` where 8.0-8.2 restart at `0` — the
parser has no idea which build `phpVersion` will select. `isDefineCall` strips one leading `\` before
comparing, because namespaced code writes `\define(...)` to skip the runtime fallback lookup; `A\define`
is a genuinely different function and stays ignored.
`RESERVED` in `codegen.ts` is _ECMAScript's_ invalid-binding list (reserved words + strict-mode additions +
`arguments`/`eval`), not PHP's keyword list: `define()` can hand codegen any name at all. Beware that Bun's
transpiler tolerates the strict-mode-only subset (`implements`…`yield`) while its module loader rejects them,
so `Bun.Transpiler` alone is not proof a generated module loads — `test/e2e.test.ts` imports a `yield`
constant through the real loader for exactly that reason. Generated `.d.ts` output must stay byte-identical
across refactors: `example/hello.php.d.ts` and `demos/php/*.php.d.ts` are committed.

**Type-mapping changes** go in `TS_TYPES` in `php-types.ts` (declared keywords and docblock-only spellings
share the one map; `convertDocPart` handles the docblock syntax around them). The precedence rule lives in
`chooseType` in `parse.ts`: a real type declaration wins, _except_ that bare `array` and `mixed` defer to a
`@param`/`@return` docblock tag.

**The plugin's `runtime` option is the serialisable half of `PhpRuntimeOptions`.** It is emitted into the
generated module by `generateModule`, so `PhpModuleRuntimeOptions` drops `loader` and function-valued
`spawn` (neither survives `JSON.stringify`) and `isolation` (which `createPhpModule` refuses outright);
`assertSerialisable` in `plugin.ts` repeats that check for JavaScript callers. The key is omitted entirely
when unset, so a module without runtime options generates byte-identically to before.

**PHP version selection lives in `BUILD_PACKAGES` in `php-runtime.ts`**, a map from version to
`@php-wasm/node-X-Y` resolved with a dynamic `import()`. `buildImportError` classifies a failed import
rather than assuming: only an `ERR_MODULE_NOT_FOUND` whose `specifier` is the build package itself is
`PhpBuildNotInstalledError` with its `bun add` advice — a transitive dependency failing inside an installed
build would otherwise be answered with "install what you already have" —
and anything else — a build that resolved but threw — is `PhpBuildLoadError`, so the message never sends
someone to install what they already have. Only 8.5 is a real dependency; the rest are optional
peer dependencies, because each build is tens of MB of wasm. `@php-wasm/node` is deliberately avoided — it
statically imports a NAN native addon that throws at module-evaluation time when its binding fails to load,
which is also why `nodeFsMountHandler` is implemented here against the Emscripten FS directly.

**Neither timeouts nor parallelism work the way you would assume in-process**, both measured:

- A running request cannot be interrupted. `PHP.exit()` mid-call returns without stopping it (a busy loop then
  ran to completion), and `max_execution_time` is ignored — a 2s limit let an 8s loop finish. So in-process
  `timeoutMs` bounds _waiting_ only: it rejects and flags the interpreter `retired` while the PHP keeps burning
  CPU. Say so wherever it is documented; a timeout that implies cancellation is worse than none.
- Interpreters do not overlap. Two concurrent 1s calls on two instances take ~2s (ratio 1.96), because the
  wasm holds the thread. That is why there is no pool API — a second interpreter in-process buys nothing, and
  `test/interpreter.test.ts` pins the ratio so nobody adds one on a hunch.

**`isolation: "process"` exists because of the previous paragraph**, plus one more measurement: the wasm heap
retains hundreds of MB across in-process boot/dispose cycles (35 MB baseline → 300–800 MB after a handful,
forced GC included) and the OS reclaiming an exited child is the only thing that returns it. Each `cli()`
spawns `src/isolation-runner.ts`, ships `{ options: { phpVersion, spawn }, journal, argv }` as JSON on stdin,
and SIGKILLs on timeout — so under isolation `timeoutMs` really cancels, concurrent calls really overlap
(1.04x measured), and a wasm abort takes only the child. The constructor rejects `loader` and function-valued
`spawn` up front because they cannot cross the JSON boundary, `php()` throws for the same reason, and
`createPhpModule` refuses `runtime.isolation` outright — the imported-module path runs many small calls
against one live instance, the opposite shape. The runner constructs a plain in-process
`PhpInterpreter(options, journal)`: the child _is_ the isolation, and reusing `cli()` keeps the two paths from
diverging. Errors cross through `serialiseError`/`reviveError`, which carry the fields of bun-php's own error
types so `instanceof`, `packageName`/`phpClass` and the cause's message survive the JSON boundary; an
unknown name stays a plain `Error`.

**Interleaving `mount()`/`writeFile()` with a concurrent `cli()` is not supported.** `#apply` awaits `php()`
and then applies the op, and in between a `cli()` can consume and exit that very instance. Twenty attempts
across both orderings produced no spurious rejection — `cli()` nulls `#instance` synchronously, so a
concurrent op boots its own — so there is no serialiser for a race nobody has reproduced. Do the setup
before the call.

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
