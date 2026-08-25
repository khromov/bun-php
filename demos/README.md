# bun-php demos

A real Composer package, driven from Bun through `bun-php`.

Each file in `php/` is ordinary PHP — `use` statements, third-party packages,
first-party classes — with no awareness that it is being called from
JavaScript. bun-php mounts the project directory into the WebAssembly
filesystem and requires `vendor/autoload.php` before each call, so Composer
resolves exactly as it would under `php-fpm` or the CLI.

## Setup

```bash
composer install --working-dir=demos   # from the repository root
bun run demos                          # run every demo
bun run inline                         # PHP with no .php file, via BunPHP`...`
bun run phpinfo                        # serve phpinfo() on http://localhost:8080
bun test demos/demos.test.ts           # assert they all still work
```

`vendor/` is gitignored; `composer.lock` is committed so installs are
reproducible.

## What is demonstrated

| Demo | Package | Shows |
| --- | --- | --- |
| `php/markdown.php` | `league/commonmark` | A package with 10+ transitive dependencies |
| `php/dates.php` | `nesbot/carbon` | Timezone maths and human-readable diffs |
| `php/ids.php` | `ramsey/uuid` | Random v4 and deterministic v5 UUIDs |
| `php/tokens.php` | `firebase/php-jwt` | HMAC signing and verification via `ext-hash` |
| `php/csv.php` | `league/csv` | Streaming reader/writer over strings |
| `php/images.php` | `ext-gd` | Decoding, resizing and re-encoding real files on disk |
| `php/inventory.php` | `Demo\Inventory` | The package's **own** PSR-4 classes, which themselves use `ramsey/uuid` |
| `php/info.php` | — | `phpinfo()`, served over HTTP by `bun run phpinfo` |

## Things worth noticing

**PHP exceptions arrive as JavaScript errors, with the PHP stack intact.**
Signing with a too-short key raises `DomainException` inside php-jwt; it
surfaces as a `PhpError` whose `phpTrace` points at the real vendor file:

```
PhpError: signToken: DomainException: Provided key is too short
  phpFile: demos/vendor/firebase/php-jwt/src/JWT.php
  phpLine: 701
```

**PHP notices and warnings are forwarded to stdout.** During development this
project surfaced a `league/csv` deprecation notice that way, which is how the
demo came to use `Reader::fromString()` rather than the deprecated
`createFromString()`.

**PHP reads and writes real files.** Because the project directory is mounted
rather than copied, `php/images.php` opens `images/mochi-1.jpg` (5184x3456,
3.0 MB) with GD and writes `images/mochi-1-thumbnail.jpg` (320x213, ~14 KB)
straight back to disk, then converts it to WebP. The generated files are
gitignored; the source photo is committed.

GD here is 2.3.3 with JPEG, PNG, WebP, AVIF and GIF support. One quirk worth
knowing: `imagescale()` rejects `IMG_BICUBIC_FIXED` in this build, so the demo
uses the default interpolation. `imagedestroy()` is also deprecated as of PHP
8.5 and has had no effect since 8.0.

**No `.php` file is required.** `demos/inline.ts` evaluates a snippet through
the `` BunPHP`...` `` tagged template, which is a plain runtime API — it needs
neither the plugin nor the `preload` entry. PHP prints for itself, so nothing
on the JavaScript side has to relay the output:

```ts
import { BunPHP } from "bun-php";
await BunPHP`<?php echo "Hello from PHP!", PHP_EOL; ?>`;   // Hello from PHP!
```

`BunPHP.capture` is the other half: it prints nothing and resolves to the
output instead.

**`bun run phpinfo` serves the real page.** `Bun.serve()` on port 8080 hands
back the output of PHP's own `phpinfo()`, with a header noting what produced
it. Worth a look for what it reports: *Server API: PHP WASM SAPI (JSPI)*,
confirming the faster JavaScript Promise Integration path rather than
Asyncify. Set `PORT` to use a different port.

**Types come from the PHP signatures.** `idVersion(string $uuid): ?int` becomes
`idVersion(uuid: string): Promise<number | null>` in the generated
`php/ids.php.d.ts`. Where a function is only hinted `: array`, the generated
type is the honest `PhpArray`; `demos/index.ts` names the concrete shape on the
TypeScript side when it needs one.

**Every call is a fresh PHP request.** Composer's autoloader is re-registered
each time, which is why `randomId()` returns a different UUID on every call and
why nothing leaks between calls.

## Cost

Measured on this machine (Bun 1.4, PHP 8.5.8 via JSPI):

| | Cold (first call) | Warm |
| --- | --- | --- |
| Plain function, no Composer | ~210 ms | ~1 ms |
| `ramsey/uuid` | ~770 ms | ~8 ms |
| `league/commonmark` | ~760 ms | ~20 ms |
| `ext-gd` resize of an 18 MP JPEG | — | ~250 ms |

The cold cost is booting WebAssembly plus registering the autoloader and
loading classes. Warm cost tracks how much work the library does per call —
Composer's optimised autoloader is lazy, so packages you touch lightly stay
cheap, while CommonMark rebuilds a sizeable environment each time.
