/**
 * PHP without a `.php` file.
 *
 * The `BunPHP` tagged template evaluates a snippet in the same PHP 8.5
 * interpreter the plugin uses, but it is a plain runtime API — no plugin
 * registration, no `preload` entry, nothing on disk.
 *
 *     bun run inline
 */
import { BunPHP } from "bun-php";

// PHP prints for itself: `echo` goes to this terminal, as it would under the
// PHP CLI. `BunPHP.capture` takes the output as a value instead.
//
// PHP_EOL rather than "\n" because a JS template literal would read the escape
// before PHP ever saw it.
await BunPHP`<?php echo "Hello from PHP!", PHP_EOL; ?>`;

await BunPHP.dispose();
