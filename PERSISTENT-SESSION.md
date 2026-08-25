# Persistent PHP session (parked for evaluation)

This branch replaces the request-per-call execution model with a single
long-running PHP request that serves every call. Not merged: the semantic
change needs a decision first.

## The question it answers

Can Composer's autoloader be kept registered between calls, instead of being
re-registered (and its classes re-executed) on every single call?

## What does not work

**php-wasm's `/internal/shared/preload/`** — implemented with
`auto_prepend_file`, so it re-runs on every request. Same cost as an explicit
`require_once`, just implicit. No persistence.

**`opcache.preload`** — PHP's official mechanism for exactly this. The ini is
read (`ini_get('opcache.preload')` returns the configured path), but
`opcache_get_status()` reports `opcache_enabled: false`. OPcache is compiled
into the php-wasm build but non-functional, so preloading never happens. This
also means there is no bytecode caching at all today: every call re-parses as
well as re-executes.

## What does work

Keep one request alive. PHP blocks inside `post_message_to_js()`; the
JavaScript listener answers with the next job. The autoloader is registered
once and loaded classes stay resident.

- `src/session.ts` — the session: job queue, result matching, restart on death
- `buildLoopScript()` in `src/marshal.ts` — the PHP loop
- `persist` option (default `true`), `phpPlugin({ persist: false })` to opt out

The isolated request-per-call path is retained in full for `persist: false`.

## Measured

| | request-per-call | persistent |
| --- | --- | --- |
| CommonMark, cold | ~760 ms | ~865 ms |
| CommonMark, warm | ~19.7 ms | **1.37 ms** |
| ramsey/uuid, warm | ~8.4 ms | **0.22 ms** |
| plain function, warm | ~1 ms | **0.07 ms** |

## Risks

- **PHP state now persists between calls.** `static` variables, globals and
  superglobals carry over. This is what a long-running PHP process does, but it
  reverses what `README.md` documents today.
- **`exit()` / `die()` ends the session.** Detected (the request promise
  resolves with the exit code) and recovered transparently on the next call,
  with fresh state. Covered by `test/session.test.ts`.
- Thrown exceptions and PHP 8 `Error`s are caught, so those leave the session
  serving.
- The process still exits cleanly with a session parked; verified, no hang.
- Calls are matched to results by queue order. `test/session.test.ts` covers
  concurrent and differing-duration calls to guard that.

## Before merging

- `README.md` — the "Each call is an isolated PHP request" section is wrong
  under this model; document `persist` and the state semantics.
- `CLAUDE.md` — the "Every call is a fresh PHP request" note needs replacing.
- `demos/README.md` — refresh the cost table.
- Decide whether `eval()` in the loop's `$eval` path is acceptable, or whether
  `$eval` should be dropped in persistent mode.

128 tests pass on this branch.
