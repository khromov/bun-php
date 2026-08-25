/**
 * These exercise real Composer packages end to end, so they need the demo
 * package's dependencies to be installed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import markdown, { renderGfm, renderMarkdown } from "./php/markdown.php";
import dates, { addWeekdays, formatIn, humanDiff } from "./php/dates.php";
import ids, { idVersion, randomId, stableId } from "./php/ids.php";
import tokens, { signToken, verifyToken } from "./php/tokens.php";
import csv, { buildCsv, parseCsv } from "./php/csv.php";
import inventory, { priceBasket } from "./php/inventory.php";

const installed = existsSync(join(import.meta.dir, "vendor", "autoload.php"));

beforeAll(() => {
  if (installed) return;
  throw new Error(
    "demos/vendor is missing, so the demo packages cannot be loaded.\n" +
      "Install them first, from the repository root:\n\n" +
      "    composer install --working-dir=demos\n",
  );
});

afterAll(async () => {
  if (!installed) return;
  await Promise.all(
    [markdown, dates, ids, tokens, csv, inventory].map((m) => m.$dispose().catch(() => {})),
  );
});

describe("league/commonmark", () => {
  test("renders CommonMark to HTML", async () => {
    expect(await renderMarkdown("# Title\n\nSome **bold** text.")).toBe(
      "<h1>Title</h1>\n<p>Some <strong>bold</strong> text.</p>",
    );
  });

  test("strips raw HTML when configured to", async () => {
    expect(await renderMarkdown("<script>alert(1)</script>")).not.toContain("<script>");
  });

  test("GitHub Flavoured Markdown adds tables and strikethrough", async () => {
    const html = await renderGfm("| a |\n|---|\n| 1 |\n\n~~gone~~");
    expect(html).toContain("<table>");
    expect(html).toContain("<del>gone</del>");
  });
});

describe("nesbot/carbon", () => {
  test("describes a difference in words", async () => {
    expect(await humanDiff("2026-08-01T12:00:00Z", "2026-08-25T12:00:00Z")).toBe(
      "3 weeks before",
    );
  });

  test("converts between timezones", async () => {
    expect(await formatIn("2026-08-25T09:30:00Z", "Asia/Tokyo")).toBe(
      "Tue, 25 Aug 2026 18:30 JST",
    );
  });

  test("skips weekends when adding weekdays", async () => {
    // 2026-08-25 is a Tuesday, so +5 weekdays lands on the following Tuesday.
    expect(await addWeekdays("2026-08-25", 5)).toBe("2026-09-01");
  });
});

describe("ramsey/uuid", () => {
  test("generates version 4 UUIDs", async () => {
    const id = await randomId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await idVersion(id)).toBe(4);
  });

  test("version 5 UUIDs are deterministic", async () => {
    const first = await stableId("bun-php.dev");
    expect(await stableId("bun-php.dev")).toBe(first);
    expect(await stableId("other.dev")).not.toBe(first);
    expect(await idVersion(first)).toBe(5);
  });

  test("rejects non-UUID input", async () => {
    expect(await idVersion("definitely-not-a-uuid")).toBeNull();
  });

  test("successive random UUIDs differ", async () => {
    // Each call is a fresh PHP request, so this also proves the RNG is not
    // being reseeded identically every time.
    expect(await randomId()).not.toBe(await randomId());
  });
});

describe("firebase/php-jwt", () => {
  const secret = "correct-horse-battery-staple-0123456789";

  test("round-trips a signed token", async () => {
    const token = await signToken({ sub: "user-42", role: "admin" }, secret);
    expect(token.split(".")).toHaveLength(3);
    expect(await verifyToken(token, secret)).toEqual({ sub: "user-42", role: "admin" });
  });

  test("rejects a token signed with a different key", async () => {
    const token = await signToken({ sub: "user-42" }, secret);
    expect(verifyToken(token, "a-completely-different-key-0123456789")).rejects.toThrow(
      /SignatureInvalid/,
    );
  });
});

describe("league/csv", () => {
  test("parses records keyed by the header row", async () => {
    expect(await parseCsv("name,qty\nwidget,3\ngadget,12")).toEqual([
      { name: "widget", qty: "3" },
      { name: "gadget", qty: "12" },
    ]);
  });

  test("handles quoted fields containing commas", async () => {
    expect(await parseCsv('name,note\nwidget,"a, b"')).toEqual([
      { name: "widget", note: "a, b" },
    ]);
  });

  test("builds CSV text", async () => {
    expect(await buildCsv(["name", "qty"], [["widget", 3]])).toBe("name,qty\nwidget,3");
  });
});

// PHP's `array` return hint cannot express a shape, so name it here.
type Basket = { total: number; summary: string; items: { id: string }[] };

describe("first-party PSR-4 classes", () => {
  test("autoloads Demo\\Inventory from the package's own src/", async () => {
    const result = (await priceBasket([
      { name: "widget", qty: 3, price: 9.99 },
      { name: "gadget", qty: 12, price: 2.5 },
    ])) as Basket;

    expect(result.total).toBe(59.97);
    expect(result.items).toHaveLength(2);
    expect(result.summary).toContain("widget");
  });

  test("first-party code can use vendor packages too", async () => {
    // Demo\Inventory derives its ids with ramsey/uuid.
    const result = (await priceBasket([
      { name: "widget", qty: 1, price: 1 },
    ])) as Basket;
    expect(result.items[0]!.id).toBe(await stableId("widget"));
  });
});
