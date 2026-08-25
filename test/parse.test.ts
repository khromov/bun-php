import { describe, expect, test } from "bun:test";
import { PhpParseError } from "../src/errors";
import { parsePhp } from "../src/parse";
import type { PhpFunctionMeta } from "../src/types";

const parse = (php: string) => parsePhp(`<?php\n${php}`, "/virtual/test.php");

const fn = (php: string, name = "f"): PhpFunctionMeta => {
  const found = parse(php).functions.find((f) => f.exportName === name);
  if (!found) throw new Error(`no function named ${name}`);
  return found;
};

const signature = (f: PhpFunctionMeta) =>
  `(${f.params
    .map((p) => `${p.variadic ? "..." : ""}${p.name}${p.optional ? "?" : ""}: ${p.tsType}`)
    .join(", ")}) => ${f.returnTsType}`;

describe("function discovery", () => {
  test("finds top-level functions", () => {
    const meta = parse(`function a() {} function b() {}`);
    expect(meta.functions.map((f) => f.exportName)).toEqual(["a", "b"]);
  });

  test("ignores class, interface and trait members", () => {
    const meta = parse(`
      function real() {}
      class C { public function method() {} public static function stat() {} }
      interface I { public function iface(); }
      trait T { public function traitMethod() {} }
      enum E { case A; public function enumMethod() {} }
    `);
    expect(meta.functions.map((f) => f.exportName)).toEqual(["real"]);
  });

  test("ignores closures and arrow functions", () => {
    const meta = parse(`
      $a = function () { return 1; };
      $b = fn($x) => $x;
      function named() {}
    `);
    expect(meta.functions.map((f) => f.exportName)).toEqual(["named"]);
  });

  test("descends through namespace and declare wrappers", () => {
    const meta = parsePhp(
      `<?php declare(strict_types=1); namespace App\\Deep; function inside() {}`,
      "/virtual/t.php",
    );
    expect(meta.functions).toHaveLength(1);
    expect(meta.functions[0]!.exportName).toBe("inside");
    expect(meta.functions[0]!.phpName).toBe("App\\Deep\\inside");
  });

  test("handles bracketed namespaces, including the global one", () => {
    const meta = parsePhp(
      `<?php namespace A\\B { function inner() {} } namespace { function outer() {} }`,
      "/virtual/t.php",
    );
    expect(meta.functions.map((f) => f.phpName).sort()).toEqual([
      "A\\B\\inner",
      "outer",
    ]);
  });

  test("skips a function whose export name collides", () => {
    const meta = parsePhp(
      `<?php namespace A { function dup() {} } namespace B { function dup() {} }`,
      "/virtual/t.php",
    );
    expect(meta.functions).toHaveLength(1);
    expect(meta.skipped.join(" ")).toContain("collides");
  });
});

describe("parameter types", () => {
  test("maps scalar type hints", () => {
    expect(signature(fn(`function f(int $a, float $b, string $c, bool $d) {}`)))
      .toBe("(a: number, b: number, c: string, d: boolean) => any");
  });

  test("untyped parameters fall back to any", () => {
    expect(signature(fn(`function f($a) {}`))).toBe("(a: any) => any");
  });

  test("?T and T|null produce the same type", () => {
    expect(fn(`function f(?int $a): ?string {}`).params[0]!.tsType).toBe(
      "number | null",
    );
    expect(fn(`function f(int|null $a): string|null {}`).params[0]!.tsType).toBe(
      "number | null",
    );
    expect(fn(`function f(?int $a): ?string {}`).returnTsType).toBe(
      "string | null",
    );
    expect(fn(`function f(int|null $a): string|null {}`).returnTsType).toBe(
      "string | null",
    );
  });

  test("union types map to TypeScript unions", () => {
    expect(fn(`function f(int|float|string $a) {}`).params[0]!.tsType).toBe(
      "number | string",
    );
  });

  test("intersection types are opaque", () => {
    expect(fn(`function f(\\Countable&\\ArrayAccess $a) {}`).params[0]!.tsType).toBe(
      "unknown",
    );
  });

  test("class references map to an object shape", () => {
    expect(fn(`function f(\\App\\Thing $t): \\App\\Thing {}`).params[0]!.tsType)
      .toBe("Record<string, unknown>");
  });

  test("array maps to PhpArray, void to void, mixed to any", () => {
    expect(fn(`function f(array $a): void {}`).params[0]!.tsType).toBe("PhpArray");
    expect(fn(`function f(array $a): void {}`).returnTsType).toBe("void");
    expect(fn(`function f(mixed $a): mixed {}`).returnTsType).toBe("any");
  });

  test("records defaults, variadics and by-reference flags", () => {
    const f = fn(`function f(string $a, int $b = 1, int ...$rest) {}`);
    expect(f.params.map((p) => p.optional)).toEqual([false, true, false]);
    expect(f.params.map((p) => p.variadic)).toEqual([false, false, true]);
    expect(fn(`function f(array &$out) {}`).params[0]!.byref).toBe(true);
  });
});

describe("docblocks", () => {
  test("extracts the summary and drops tags from it", () => {
    const f = fn(`
      /**
       * Does a thing.
       *
       * @param int $a A number
       * @return string
       */
      function f($a) {}
    `);
    expect(f.doc).toBe("Does a thing.");
    expect(signature(f)).toBe("(a: number) => string");
  });

  test("takes the last docblock, not a stray preceding comment", () => {
    const f = fn(`
      function other() {} // trailing comment
      /** The real docblock. */
      function f() {}
    `);
    expect(f.doc).toBe("The real docblock.");
  });

  test("a declared type beats the docblock", () => {
    expect(fn(`/** @param int $a */ function f(string $a) {}`).params[0]!.tsType)
      .toBe("string");
  });

  test("the docblock beats a bare array hint", () => {
    const f = fn(`
      /**
       * @param float[] $values
       * @return array<string, float>
       */
      function f(array $values): array {}
    `);
    expect(signature(f)).toBe("(values: number[]) => Record<string, number>");
  });

  test("generics containing spaces are not truncated", () => {
    expect(fn(`/** @return array<string, int> */ function f() {}`).returnTsType)
      .toBe("Record<string, number>");
  });

  test("nullable declaration survives a docblock override", () => {
    expect(fn(`/** @param int[] $a */ function f(?array $a) {}`).params[0]!.tsType)
      .toBe("number[] | null");
  });
});

describe("constants", () => {
  test("reads literal const values", () => {
    const meta = parse(`
      const S = 'hi';
      const N = 42;
      const F = 1.5;
      const NEG = -7;
      const T = true;
      const NU = null;
    `);
    expect(meta.constants).toEqual([
      { name: "S", value: "hi" },
      { name: "N", value: 42 },
      { name: "F", value: 1.5 },
      { name: "NEG", value: -7 },
      { name: "T", value: true },
      { name: "NU", value: null },
    ]);
  });

  test("parses PHP numeric literal forms", () => {
    const meta = parse(`
      const SEP = 1_000;
      const HEX = 0x1F;
      const BIN = 0b1010;
      const OCT = 017;
      const NEWOCT = 0o17;
    `);
    expect(meta.constants.map((c) => c.value)).toEqual([1000, 31, 10, 15, 15]);
  });

  test("reads list and associative array literals", () => {
    const meta = parse(`
      const NUMS = [1, 2, 3];
      const MAP = ['a' => 1, 'b' => [2, 3]];
    `);
    expect(meta.constants[0]!.value).toEqual([1, 2, 3]);
    expect(meta.constants[1]!.value).toEqual({ a: 1, b: [2, 3] });
  });

  test("picks up define() calls", () => {
    const meta = parse(`define('ANSWER', 42);`);
    expect(meta.constants).toEqual([{ name: "ANSWER", value: 42 }]);
  });

  test("skips values that need PHP to evaluate", () => {
    const meta = parse(`const C = 'a' . 'b'; const OK = 1;`);
    expect(meta.constants).toEqual([{ name: "OK", value: 1 }]);
    expect(meta.skipped.join(" ")).toContain("C");
  });

  test("ignores class constants", () => {
    const meta = parse(`class C { const INNER = 1; } const OUTER = 2;`);
    expect(meta.constants).toEqual([{ name: "OUTER", value: 2 }]);
  });
});

describe("errors", () => {
  test("a syntax error becomes a PhpParseError with a line number", () => {
    expect(() => parsePhp("<?php function {", "/virtual/bad.php")).toThrow(
      PhpParseError,
    );
    try {
      parsePhp("<?php function {", "/virtual/bad.php");
    } catch (error) {
      expect(error).toBeInstanceOf(PhpParseError);
      expect((error as PhpParseError).file).toBe("/virtual/bad.php");
      expect((error as PhpParseError).line).toBe(1);
    }
  });
});
