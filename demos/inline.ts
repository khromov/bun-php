import { BunPHP } from "bun-php";

await BunPHP`<?php echo "Hello from PHP!", PHP_EOL; ?>`;
