import { describe, expect, test } from "bun:test";
import { generateModule, isBindableIdentifier } from "../src/codegen";
import { generateDts } from "../src/dts";
import { parsePhp } from "../src/parse";

const build = (php: string) => {
  const source = `<?php\n${php}`;
  const meta = parsePhp(source, "/virtual/mod.php");
  return {
    meta,
    js: generateModule({
      path: "/virtual/mod.php",
      source,
      meta,
      runtimeSpecifier: "/runtime.ts",
      stdout: "inherit",
      root: null,
      autoload: null,
    }),
    dts: generateDts(meta, "mod.php"),
  };
};

describe("isBindableIdentifier", () => {
  test("accepts ordinary names", () => {
    expect(isBindableIdentifier("greet")).toBe(true);
    expect(isBindableIdentifier("_private")).toBe(true);
    expect(isBindableIdentifier("addAll2")).toBe(true);
  });

  test("rejects names strict mode forbids binding", () => {
    // Not reserved words, but a module is always strict.
    expect(isBindableIdentifier("arguments")).toBe(false);
    expect(isBindableIdentifier("eval")).toBe(false);
  });

  test("rejects reserved words and invalid characters", () => {
    expect(isBindableIdentifier("delete")).toBe(false);
    expect(isBindableIdentifier("class")).toBe(false);
    expect(isBindableIdentifier("new")).toBe(false);
    expect(isBindableIdentifier("2fast")).toBe(false);
  });
});

describe("generated module", () => {
  test("exports each function as a named binding", () => {
    const { js } = build(`function greet(string $n): string {}`);
    expect(js).toContain(`export const greet = (...args) => __mod.call("greet", args);`);
  });

  test("inlines the source and the function name map", () => {
    const { js } = build(`namespace App; function greet() {}`);
    expect(js).toContain(`functions: {"greet":"App\\\\greet"}`);
    expect(js).toContain(`id: "/virtual/mod.php"`);
    expect(js).toContain("source:");
  });

  test("re-exports reserved words under an alias", () => {
    const { js } = build(`function delete_it() {} function classy() {}`);
    expect(js).toContain("export const delete_it");
    expect(js).toContain("export const classy");
  });

  test("binds an actual reserved word safely", () => {
    const { js } = build(`function delete() {}`);
    expect(js).not.toContain("export const delete =");
    expect(js).toContain(`export { __phpFn_delete as "delete" };`);
  });

  test("binds `arguments` under an alias, as strict mode demands", () => {
    // `function arguments()` is legal PHP; `const arguments` is not legal in
    // a module, which is always strict-mode code.
    const { js } = build(`function arguments() {}`);
    expect(js).not.toContain("export const arguments");
    expect(js).toContain(`export { __phpFn_arguments as "arguments" };`);
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(js)).not.toThrow();
  });

  test("aliases a constant named eval", () => {
    const { js } = build(`define('eval', 1);`);
    expect(js).toContain(`export { __phpConst_eval as "eval" };`);
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(js)).not.toThrow();
  });

  test("emits constants as plain values", () => {
    const { js } = build(`const A = 'x'; const B = [1, 2];`);
    expect(js).toContain(`export const A = "x";`);
    expect(js).toContain(`export const B = [1,2];`);
  });

  test("notes skipped declarations in a comment", () => {
    const { js } = build(`const C = 'a' . 'b';`);
    expect(js).toContain("// Not exported:");
    expect(js).toContain("C");
  });

  test("is valid JavaScript that Bun can transpile", () => {
    const { js } = build(`
      function greet(string $n): string {}
      function delete() {}
      const A = 'x';
    `);
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(js)).not.toThrow();
  });
});

describe("generated .d.ts", () => {
  test("wraps return types in Promise", () => {
    const { dts } = build(`function greet(string $n): string {}`);
    expect(dts).toContain("export declare function greet(n: string): Promise<string>;");
  });

  test("marks defaulted parameters optional", () => {
    const { dts } = build(`function f(string $a, int $b = 1): void {}`);
    expect(dts).toContain("function f(a: string, b?: number): Promise<void>;");
  });

  test("optionality is sticky once it starts", () => {
    // PHP allows a required parameter after an optional one; TypeScript does not.
    const { dts } = build(`function f(int $a = 1, string $b): void {}`);
    expect(dts).toContain("function f(a?: number, b?: string): Promise<void>;");
  });

  test("renders variadics as rest parameters", () => {
    const { dts } = build(`function f(int ...$rest): int {}`);
    expect(dts).toContain("function f(...rest: number[]): Promise<number>;");
  });

  test("parenthesises a union element type in a rest parameter", () => {
    const { dts } = build(`function f(int|string ...$rest): int {}`);
    expect(dts).toContain("...rest: (number | string)[]");
  });

  test("carries the docblock summary into JSDoc", () => {
    const { dts } = build(`/** Greets someone. */ function greet(): string {}`);
    expect(dts).toContain("* Greets someone.");
  });

  test("warns about by-reference parameters", () => {
    const { dts } = build(`function f(array &$out): void {}`);
    expect(dts).toContain("$out is by-reference in PHP");
    expect(dts).toContain("not reflected back");
  });

  test("gives constants literal types", () => {
    const { dts } = build(`const S = 'hi'; const N = 42; const T = true;`);
    expect(dts).toContain(`export declare const S: "hi";`);
    expect(dts).toContain("export declare const N: 42;");
    expect(dts).toContain("export declare const T: true;");
  });

  test("gives array constants a structural type", () => {
    const { dts } = build(`const A = [1, 'x']; const M = ['k' => 1];`);
    expect(dts).toContain(`export declare const A: readonly [1, "x"];`);
    expect(dts).toContain(`export declare const M: { readonly "k": 1 };`);
  });

  test("lists every function on the default export", () => {
    const { dts } = build(`function a() {} function b() {}`);
    expect(dts).toContain("a: typeof a;");
    expect(dts).toContain("b: typeof b;");
    expect(dts).toContain("export default _default;");
  });

  test("is self-contained, with no imports to resolve", () => {
    const { dts } = build(`function f(array $a): array {}`);
    expect(dts).not.toContain("import");
    expect(dts).toContain("type PhpArray =");
  });

  test("types the default export the way PhpModuleApi does", () => {
    // A .php import resolves to the sidecar, so anything missing here is untypeable for the caller.
    const { dts } = build(`function f(): void {}`);
    expect(dts).toContain("$eval(code: string, onOutput?: (text: string) => void): Promise<any>;");
    // $reset is lazy: it discards state and lets the *next* call pay for the boot.
    expect(dts).toContain("/** Discard all PHP state; the next call boots a fresh interpreter. */");
  });

  test("the committed example sidecar is current", async () => {
    // example/hello.php.d.ts is checked in as a worked example, so a dts change must regenerate it.
    const path = "example/hello.php";
    const source = await Bun.file(path).text();
    expect(generateDts(parsePhp(source, path), "hello.php")).toBe(
      await Bun.file(`${path}.d.ts`).text(),
    );
  });
});

/**
 * Every name a module cannot bind: ECMAScript reserved words, the strict-mode
 * additions, and the restricted `arguments`/`eval`. Kept in sync with RESERVED
 * in codegen.ts by the assertions below rather than by exporting the set.
 */
const STRICT_MODE_INVALID = [
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
];

describe("reserved word coverage", () => {
  const transpiles = (js: string) =>
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(js)).not.toThrow();

  test("every reserved word arriving via define() is aliased, never bound", () => {
    // PHP's define() accepts any string, so all of these are reachable.
    for (const word of STRICT_MODE_INVALID) {
      const { js } = build(`define('${word}', 1);`);
      if (word === "default") {
        // Already claimed by the module's own default export.
        expect(js).toContain("collides");
        continue;
      }
      expect(js).not.toContain(`export const ${word} `);
      expect(js).toContain(`export { __phpConst_${word} as ${JSON.stringify(word)} };`);
      transpiles(js);
    }
  });

  test("reserved words PHP accepts as function names take the alias path", () => {
    let reachable = 0;
    for (const word of STRICT_MODE_INVALID) {
      let js: string;
      try {
        js = build(`function ${word}() {}`).js;
      } catch {
        continue; // Also a PHP keyword: it can never reach codegen this way.
      }
      reachable++;
      expect(js).not.toContain(`export const ${word} `);
      expect(js).toContain(`export { __phpFn_${word} as ${JSON.stringify(word)} };`);
      transpiles(js);
    }
    // arguments, await, debugger, delete, enum, let, this, true, ... are all
    // legal PHP function names; make sure the loop actually exercised them.
    expect(reachable).toBeGreaterThanOrEqual(15);
  });
});
