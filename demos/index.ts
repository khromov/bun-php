/**
 * Runs every demo in turn.
 *
 * Each `.php` file below is a real Composer project file: it uses `use`
 * statements for third-party packages, and bun-php mounts the project so
 * `vendor/autoload.php` resolves exactly as it would under `php-fpm`.
 */
import { renderGfm, renderMarkdown } from "./php/markdown.php";
import { addWeekdays, formatIn, humanDiff } from "./php/dates.php";
import { idVersion, randomId, stableId } from "./php/ids.php";
import { signToken, verifyToken } from "./php/tokens.php";
import { buildCsv, parseCsv } from "./php/csv.php";
import type { PhpError } from "bun-php";
import { priceBasket } from "./php/inventory.php";
import { imageInfo, thumbnail, toWebp } from "./php/images.php";

function heading(title: string, packageName: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m \x1b[2m— ${packageName}\x1b[0m`);
}

heading("Markdown", "league/commonmark");
console.log(await renderMarkdown("# Hello\n\nFrom **PHP**, running in *WebAssembly*."));
console.log(await renderGfm("| lang | runtime |\n|---|---|\n| PHP | Bun |"));

heading("Dates", "nesbot/carbon");
console.log("human diff: ", await humanDiff("2026-08-01T12:00:00Z", "2026-08-25T12:00:00Z"));
console.log("in Tokyo:   ", await formatIn("2026-08-25T09:30:00Z", "Asia/Tokyo"));
console.log("+5 weekdays:", await addWeekdays("2026-08-25", 5));

heading("UUIDs", "ramsey/uuid");
const generated = await randomId();
console.log("random (v4):", generated, `-> version ${await idVersion(generated)}`);
console.log("stable (v5):", await stableId("bun-php.dev"));
console.log("not a uuid: ", await idVersion("nope"));

heading("JWT", "firebase/php-jwt");
// HS256 requires a key of at least 256 bits; the library rejects shorter ones.
const secret = "correct-horse-battery-staple-0123456789";
const token = await signToken({ sub: "user-42", role: "admin" }, secret);
console.log("signed:  ", token.slice(0, 48) + "...");
console.log("verified:", await verifyToken(token, secret));
try {
  await verifyToken(token, "another-key-that-is-long-enough-000000");
} catch (error) {
  // PHP exceptions arrive as PhpError, carrying the original class name.
  console.log("rejected:", (error as PhpError).phpClass);
}

heading("CSV", "league/csv");
const records = await parseCsv("name,qty\nwidget,3\ngadget,12");
console.log("parsed:", records);
console.log(
  "built:\n" +
    (await buildCsv(
      ["name", "qty"],
      [
        ["widget", 3],
        ["gadget", 12],
      ],
    )),
);

heading("Images", "ext-gd");
// The project directory is mounted, so PHP reads and writes real files here.
const images = `${import.meta.dir}/images`;
const source = `${images}/mochi-1.jpg`;
type Info = { width: number; height: number; mime: string; bytes: number };
type Resized = { from: Info; to: Info; bytes: number };

const original = (await imageInfo(source)) as Info;
console.log(
  `source:    ${original.width}x${original.height} ${original.mime} ${(original.bytes / 1024 / 1024).toFixed(1)}MB`,
);

const resized = (await thumbnail(source, `${images}/mochi-1-thumbnail.jpg`, 320)) as Resized;
console.log(
  `thumbnail: ${resized.to.width}x${resized.to.height} jpeg ${(resized.bytes / 1024).toFixed(1)}KB -> images/mochi-1-thumbnail.jpg`,
);

const webp = (await toWebp(
  `${images}/mochi-1-thumbnail.jpg`,
  `${images}/mochi-1-thumbnail.webp`,
)) as { bytes: number };
console.log(`converted: ${webp.bytes} bytes webp -> images/mochi-1-thumbnail.webp`);

heading("First-party classes", "Demo\\Inventory via PSR-4");
// `priceBasket` is declared `: array` in PHP, which is as specific as a type
// hint can get, so the shape is named here on the TypeScript side.
type Basket = { total: number; summary: string; items: { id: string }[] };

const basket = (await priceBasket([
  { name: "widget", qty: 3, price: 9.99 },
  { name: "gadget", qty: 12, price: 2.5 },
])) as Basket;
console.log(basket.summary);
console.log("total:", basket.total);
