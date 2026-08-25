import { BunPHP } from "bun-php";

console.log(await BunPHP`<?php echo "Hello from PHP!"; ?>`);

await BunPHP.dispose();
