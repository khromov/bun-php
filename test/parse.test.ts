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
    expect(meta.functions.map((f) => f.phpName).sort()).toEqual(["A\\B\\inner", "outer"]);
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
    expect(signature(fn(`function f(int $a, float $b, string $c, bool $d) {}`))).toBe(
      "(a: number, b: number, c: string, d: boolean) => any",
    );
  });

  test("untyped parameters fall back to any", () => {
    expect(signature(fn(`function f($a) {}`))).toBe("(a: any) => any");
  });

  test("?T and T|null produce the same type", () => {
    expect(fn(`function f(?int $a): ?string {}`).params[0]!.tsType).toBe("number | null");
    expect(fn(`function f(int|null $a): string|null {}`).params[0]!.tsType).toBe("number | null");
    expect(fn(`function f(?int $a): ?string {}`).returnTsType).toBe("string | null");
    expect(fn(`function f(int|null $a): string|null {}`).returnTsType).toBe("string | null");
  });

  test("union types map to TypeScript unions", () => {
    expect(fn(`function f(int|float|string $a) {}`).params[0]!.tsType).toBe("number | string");
  });

  test("intersection types are opaque", () => {
    expect(fn(`function f(\\Countable&\\ArrayAccess $a) {}`).params[0]!.tsType).toBe("unknown");
  });

  test("class references map to an object shape", () => {
    expect(fn(`function f(\\App\\Thing $t): \\App\\Thing {}`).params[0]!.tsType).toBe(
      "Record<string, unknown>",
    );
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
    expect(fn(`/** @param int $a */ function f(string $a) {}`).params[0]!.tsType).toBe("string");
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

  test("integer-keyed generics are lists, not records", () => {
    expect(fn(`/** @return array<int, string> */ function f() {}`).returnTsType).toBe("string[]");
    expect(fn(`/** @return list<int> */ function f() {}`).returnTsType).toBe("number[]");
    expect(fn(`/** @return array<string, int> */ function f() {}`).returnTsType).toBe(
      "Record<string, number>",
    );
  });

  test("generics containing spaces are not truncated", () => {
    expect(fn(`/** @return array<string, int> */ function f() {}`).returnTsType).toBe(
      "Record<string, number>",
    );
  });

  test("nullable declaration survives a docblock override", () => {
    expect(fn(`/** @param int[] $a */ function f(?array $a) {}`).params[0]!.tsType).toBe(
      "number[] | null",
    );
  });

  test("unions inside generics are not shredded", () => {
    expect(fn(`/** @return array<int|string> */ function f() {}`).returnTsType).toBe(
      "(number | string)[]",
    );
    expect(fn(`/** @return array<string, int|null> */ function f() {}`).returnTsType).toBe(
      "Record<string, number | null>",
    );
  });

  test("a parenthesised union with an array suffix survives", () => {
    expect(fn(`/** @param (int|string)[] $x */ function f(array $x) {}`).params[0]!.tsType).toBe(
      "(number | string)[]",
    );
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

  test("skips a name that collides with the default export", () => {
    // define() accepts names a `const` declaration could not.
    const meta = parse(`define('default', 1); const OK = 2;`);
    expect(meta.constants).toEqual([{ name: "OK", value: 2 }]);
    expect(meta.skipped.join(" ")).toContain("default");
  });

  test("skips names that would sanitise to the same binding", () => {
    const meta = parse(`define('A-B', 1); define('A.B', 2);`);
    expect(meta.constants).toEqual([{ name: "A-B", value: 1 }]);
    expect(meta.skipped.join(" ")).toContain("A.B");
  });

  test("skips a constant colliding with a function name", () => {
    const meta = parse(`function dup() {} define('dup', 1);`);
    expect(meta.functions.map((f) => f.exportName)).toEqual(["dup"]);
    expect(meta.constants).toEqual([]);
    expect(meta.skipped.join(" ")).toContain("dup");
  });

  test("skips a name that collides with a generated binding", () => {
    const meta = parse(`define('__mod', 1); const OK = 2;`);
    expect(meta.constants).toEqual([{ name: "OK", value: 2 }]);
  });

  test("skips functions named after generated bindings", () => {
    const meta = parse(`function __mod() {} function createPhpModule() {} function _default() {}`);
    expect(meta.functions).toEqual([]);
    expect(meta.skipped).toHaveLength(3);
  });

  test("skips a function colliding with a constant name", () => {
    const meta = parse(`const dup = 1; function dup() {}`);
    expect(meta.constants).toEqual([{ name: "dup", value: 1 }]);
    expect(meta.functions).toEqual([]);
    expect(meta.skipped.join(" ")).toContain("dup");
  });

  test("equal-named constants in different namespaces collide", () => {
    // The namespace prefix is not part of a constant's export name.
    const meta = parsePhp(
      `<?php namespace A { const X = 1; } namespace B { const X = 2; }`,
      "/virtual/t.php",
    );
    expect(meta.constants).toEqual([{ name: "X", value: 1 }]);
    expect(meta.skipped.join(" ")).toContain("X");
  });

  test("ignores class constants", () => {
    const meta = parse(`class C { const INNER = 1; } const OUTER = 2;`);
    expect(meta.constants).toEqual([{ name: "OUTER", value: 2 }]);
  });
});

describe("constant evaluation follows PHP semantics", () => {
  test("implicit keys continue from the highest integer key", () => {
    const meta = parse(`const F = [5 => 'x', 'y'];`);
    expect(meta.constants[0]!.value).toEqual({ "5": "x", "6": "y" });
  });

  test("float, bool and numeric-string keys collapse to the same int key", () => {
    const meta = parse(`const K = [1.5 => 'f', true => 't', '1' => 's'];`);
    expect(meta.constants[0]!.value).toEqual({ "1": "s" });
  });

  test("explicit sequential integer keys still make a list", () => {
    const meta = parse(`const L = [0 => 'a', 1 => 'b'];`);
    expect(meta.constants[0]!.value).toEqual(["a", "b"]);
  });

  test("non-canonical numeric strings stay string keys", () => {
    const meta = parse(`const N = ['01' => 'a', '-0' => 'b'];`);
    expect(meta.constants[0]!.value).toEqual({ "01": "a", "-0": "b" });
  });

  test("negation uses PHP truthiness, not JavaScript's", () => {
    const meta = parse(`const A = !'0'; const B = !''; const C = ![]; const D = !'x';`);
    expect(meta.constants.map((c) => c.value)).toEqual([true, true, true, false]);
  });

  test("an overflowing literal is skipped rather than exported as null", () => {
    // 1e999 is INF in PHP; JSON.stringify would silently turn it into null.
    const meta = parse(`const H = 1e999;`);
    expect(meta.constants).toEqual([]);
    expect(meta.skipped.join(" ")).toContain("H");
  });
});

describe("errors", () => {
  test("known limitation: php-parser rejects `function readonly()`", () => {
    // Real PHP 8.5 allows `readonly` as a function name; php-parser 3.7.0
    // does not. If this test starts failing after a php-parser upgrade, the
    // limitation is gone: delete this test and the README note.
    expect(() => parse(`function readonly() {}`)).toThrow(PhpParseError);
  });

  test("a syntax error becomes a PhpParseError with a line number", () => {
    expect(() => parsePhp("<?php function {", "/virtual/bad.php")).toThrow(PhpParseError);
    try {
      parsePhp("<?php function {", "/virtual/bad.php");
    } catch (error) {
      expect(error).toBeInstanceOf(PhpParseError);
      expect((error as PhpParseError).file).toBe("/virtual/bad.php");
      expect((error as PhpParseError).line).toBe(1);
    }
  });
});

describe("docblocks", () => {
  test("a variadic is typed the same however the docblock spells it", () => {
    // PSR-5 describes one element, the array form describes the collected array; both mean string[].
    const psr5 = fn(`/** @param string ...$args */ function f(...$args) {}`, "f");
    const arrayForm = fn(`/** @param string[] $args */ function f(...$args) {}`, "f");
    const declared = fn(`function f(string ...$args) {}`, "f");

    expect(psr5.params[0]!.tsType).toBe("string");
    expect(arrayForm.params[0]!.tsType).toBe("string");
    expect(declared.params[0]!.tsType).toBe("string");
  });

  test("a non-variadic keeps the docblock type exactly", () => {
    // Only a variadic gives up a level; `@param string[] $rows` on a plain parameter is an array.
    expect(fn(`/** @param string[] $rows */ function f($rows) {}`, "f").params[0]!.tsType).toBe(
      "string[]",
    );
  });

  test("the summary stops at the first tag, whichever tag it is", () => {
    const meta = fn(
      `/**
        * Real summary.
        *
        * @throws RuntimeException when the widget explodes
        *   and this line continues @throws, not the summary
        * @param int $n
        */
       function f(int $n): int {}`,
      "f",
    );
    expect(meta.doc).toBe("Real summary.");
  });
});
