import phpModule, { addAll, greet, money, stats, GREETING } from "./hello.php";

console.log(await greet("world"));
console.log(await greet("Bun", "Hey"));
console.log("GREETING constant:", GREETING);

console.log("addAll(1..5):", await addAll(1, 2, 3, 4, 5));
console.log("stats:", await stats([2, 4, 6, 9]));
console.log("money:", await money(1234567.891));

console.log("PHP version:", await phpModule.$eval("return PHP_VERSION;"));

await phpModule.$dispose();
