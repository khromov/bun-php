import { BunPHP } from "bun-php";

await BunPHP`<?php echo "Hello from PHP!"; ?>`;

const started = performance.now();
const at = (): string => `${((performance.now() - started) / 1000).toFixed(1)}s`;

console.log(`\n[js  ${at()}] one snippet, three logs a second apart:`);

await BunPHP`<?php
  $t0 = microtime(true);
  foreach ([1, 2, 3] as $n) {
    printf("[php %.1fs] log %d%s", microtime(true) - $t0, $n, PHP_EOL);
    sleep(1);
  }
`;

console.log(`[js  ${at()}] snippet returned`);

await BunPHP.dispose();
