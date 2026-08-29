/**
 * Property-based tests for the JS⇄PHP boundary, using fast-check. Everything here is an invariant
 * the table-driven tests state one example of at a time: the example files pin the cases we know
 * about, these pin the shape.
 *
 * Every describe is titled `property: …` because `conventions.test.ts` requires describe titles to be
 * unique across the whole suite. `BUN_PHP_FUZZ_RUNS` raises the run count for a deep sweep; a failure
 * prints the seed, which `fc.assert(prop, { seed })` replays.
 */
import { afterAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { bindingNameFor, exportLines, generateModule, isBindableIdentifier } from "../src/codegen";
import { generateDts } from "../src/dts";
import { PhpError, PhpFatalError, PhpParseError, PhpTimeoutError } from "../src/errors";
import { asClosureBody, scanMode } from "../src/inline";
import { encodeArgs, encodeValue, EnvelopeSplitter, SENTINEL } from "../src/marshal";
import { reviveError, serialiseError } from "../src/isolation";
import { parsePhp } from "../src/parse";
import { PhpBuildLoadError, PhpBuildNotInstalledError } from "../src/php-runtime";
import { docTypeToTs, nullable } from "../src/php-types";
import { createPhpModule } from "../src/runtime";
import type { PhpConstantMeta, PhpFunctionMeta, PhpModuleMeta, PhpValue } from "../src/types";
import echo, { echoBack, typeOf } from "./fixtures/echo.php";

fc.configureGlobal({ numRuns: Number(process.env.BUN_PHP_FUZZ_RUNS ?? 100) });

const FIXTURE = new URL("./fixtures/echo.php", import.meta.url).pathname;

afterAll(async () => {
  await echo.$dispose();
});

/** JSON-safe values, the ones `phpVar` is meant to carry unchanged. */
const jsonValue = fc.jsonValue() as fc.Arbitrary<PhpValue>;

/**
 * Strings holding a lone surrogate. Built by splicing one in rather than filtering, because
 * `fc.string()` produces well-formed strings at every `unit` — including `"binary"` — so a filter
 * starves and the property silently tests nothing.
 */
const illFormed = fc
  .tuple(fc.string(), fc.integer({ min: 0xd800, max: 0xdfff }), fc.string())
  .map(([before, unit, after]) => before + String.fromCharCode(unit) + after)
  .filter((text) => !text.isWellFormed());

describe("property: encodeValue", () => {
  /**
   * `phpVar` is a fixed template, so its output can be read back in JS. Inverting it here is what
   * lets the round trip be checked without booting wasm at all.
   */
  function decodePhpVar(expression: string): unknown {
    const match = /^json_decode\(base64_decode\('(.*)'\), true\)$/.exec(expression);
    if (!match) throw new Error(`not a phpVar expression: ${expression}`);
    return JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(match[1]!), (c) => c.charCodeAt(0))),
    );
  }

  test("a JSON-safe value survives the encoding unchanged", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expect(decodePhpVar(encodeValue(value, "x"))).toEqual(JSON.parse(JSON.stringify(value)));
      }),
    );
  });

  test("encoding the same value twice gives the same expression", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expect(encodeValue(value, "x")).toBe(encodeValue(value, "x"));
      }),
    );
  });

  test("every rejection is a TypeError naming the value", () => {
    // The `startsWith(context)` guard in the catch is what keeps a wrapped failure from being
    // re-wrapped, so every path out of encodeValue has to satisfy it.
    fc.assert(
      fc.property(fc.anything(), fc.string(), (value, context) => {
        try {
          encodeValue(value, context);
        } catch (err) {
          expect(err).toBeInstanceOf(TypeError);
          expect((err as Error).message.startsWith(context)).toBe(true);
        }
      }),
    );
  });

  test("a lone surrogate is refused wherever it hides", () => {
    // PHP's json_decode rejects the whole document, so one bad code unit anywhere used to null the
    // entire argument rather than just the string holding it.
    fc.assert(
      fc.property(illFormed, (text) => {
        const message = /lone UTF-16 surrogate/;
        expect(() => encodeValue(text, "x")).toThrow(message);
        expect(() => encodeValue([text], "x")).toThrow(message);
        expect(() => encodeValue({ a: { b: text } }, "x")).toThrow(message);
        expect(() => encodeValue({ [text]: 1 }, "x")).toThrow(message);
      }),
    );
  });

  test("a well-formed string is never mistaken for a lone surrogate", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (text) => {
        expect(() => encodeValue({ [text]: text }, "x")).not.toThrow();
      }),
    );
  });

  test("a BigInt inside PHP's 64-bit range encodes as an int literal", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }), (value) => {
        const encoded = encodeValue(value, "x");
        // PHP_INT_MIN is the one value PHP reads as a negated float literal rather than an int.
        expect(encoded).toBe(
          value === -(2n ** 63n) ? "(-9223372036854775807 - 1)" : value.toString(),
        );
      }),
    );
  });

  test("a BigInt outside it overflows rather than silently wrapping", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 2n ** 63n, max: 2n ** 80n }), (magnitude) => {
        expect(() => encodeValue(magnitude, "x")).toThrow(/overflows/);
        expect(() => encodeValue(-magnitude - 1n, "x")).toThrow(/overflows/);
      }),
    );
  });

  test("trailing undefined arguments are dropped so PHP defaults apply", () => {
    fc.assert(
      fc.property(fc.array(jsonValue), fc.nat({ max: 5 }), (args, extra) => {
        const padded = [...args, ...Array.from({ length: extra }, () => undefined)];
        expect(encodeArgs(padded)).toBe(encodeArgs(args));
      }),
    );
  });
});

describe("property: EnvelopeSplitter", () => {
  /** Feed `chunks` through a splitter and report everything observable about the result. */
  function split(chunks: readonly string[]) {
    let out = "";
    const splitter = new EnvelopeSplitter((text) => {
      out += text;
    });
    for (const chunk of chunks) splitter.push(chunk);
    const envelope = splitter.end();
    return { out, envelope: JSON.stringify(envelope ?? null), tail: splitter.tail };
  }

  /**
   * Plain strings essentially never contain an eight-character NUL-delimited sentinel, so an
   * unsalted generator would exercise nothing but the passthrough path.
   */
  const stdout = fc
    .array(
      fc.oneof(
        fc.string(),
        fc.constant(SENTINEL),
        // A prefix that could still grow into a sentinel across a chunk boundary.
        fc.constant(SENTINEL.slice(0, 4)),
        fc.constant('{"ok":true,"v":1}'),
        fc.constant('{"ok":true,"v":2,"out":"buffered"}'),
        fc.constant("not json"),
      ),
      { maxLength: 12 },
    )
    .map((parts) => parts.join(""));

  /** Cut `text` at arbitrary points, the way a stream arrives. */
  const chunked = (text: string) =>
    fc.array(fc.nat({ max: Math.max(text.length, 1) }), { maxLength: 8 }).map((cuts) => {
      const points = [...new Set([0, ...cuts, text.length])].sort((a, b) => a - b);
      return points.slice(0, -1).map((at, i) => text.slice(at, points[i + 1]!));
    });

  test("an arbitrary chunking is indistinguishable from one push", () => {
    // Generalises the fixed two-way sweep in marshal.test.ts: a sentinel may straddle any boundary,
    // and all three observables have to agree, not just the envelope.
    fc.assert(
      fc.property(
        stdout.chain((text) => fc.tuple(fc.constant(text), chunked(text))),
        ([text, chunks]) => {
          expect(chunks.join("")).toBe(text);
          expect(split(chunks)).toEqual(split([text]));
        },
      ),
    );
  });

  test("output with no sentinel in it is passed through verbatim", () => {
    fc.assert(
      fc.property(
        fc.string().filter((text) => !text.includes(SENTINEL)),
        (text) => {
          const result = split([text]);
          expect(result.out).toBe(text);
          expect(result.envelope).toBe("null");
        },
      ),
    );
  });

  test("tail is the last of everything written", () => {
    fc.assert(
      fc.property(stdout, (text) => {
        const result = split([text]);
        expect(result.tail).toBe(result.out.slice(-8192));
      }),
    );
  });

  test("empty pushes change nothing", () => {
    fc.assert(
      fc.property(
        stdout.chain((text) => fc.tuple(fc.constant(text), chunked(text))),
        ([text, chunks]) => {
          expect(split(chunks.flatMap((chunk) => ["", chunk, ""]))).toEqual(split([text]));
        },
      ),
    );
  });
});

describe("property: asClosureBody", () => {
  /** Snippet-shaped strings: PHP tags and the constructs whose insides look like tags but are not. */
  const snippet = fc
    .array(
      fc.oneof(
        fc.string(),
        ...[
          "<?php ",
          "<?= ",
          "?>",
          "<?",
          "/*",
          "*/",
          "//",
          "#",
          "'",
          '"',
          "<<<EOT\n",
          "#[",
          "#[Attr]",
          "EOT;\n",
          "\n",
        ].map((token) => fc.constant(token)),
        fc.constant("echo 1;"),
        fc.constant("<div>x</div>"),
      ),
      { maxLength: 10 },
    )
    .map((parts) => parts.join(""));

  test("the body always ends in code mode, so the wrapper's brace is not swallowed", () => {
    // The snippet runs inside `(static function () { ... })`, so a body left in markup mode would
    // turn the closing brace into literal text.
    fc.assert(
      fc.property(snippet, (code) => {
        expect(scanMode(asClosureBody(code)).endsInCode).toBe(true);
      }),
    );
  });

  test("no snippet makes it throw", () => {
    // A malformed snippet has to reach PHP and fail there with a PHP error, not die in the tag.
    fc.assert(
      fc.property(fc.oneof(snippet, fc.string()), (code) => {
        expect(() => asClosureBody(code)).not.toThrow();
      }),
    );
  });
});

describe("property: bindingNameFor", () => {
  /** `define()` accepts names a `const` declaration cannot, so any string can reach codegen. */
  const phpName = fc.oneof(
    fc.string(),
    fc.constantFrom("yield", "class", "await", "arguments", "eval", "implements", "default"),
    fc.constantFrom("__mod", "createPhpModule", "_default", "call"),
    fc.constantFrom("", " ", "a-b", "a.b", "9lives", "$x", "üñî", "🎉"),
  );
  const kind = fc.constantFrom<"function" | "constant">("function", "constant");

  test("the binding it picks is always a legal JavaScript binding", () => {
    fc.assert(
      fc.property(phpName, kind, (name, k) => {
        expect(isBindableIdentifier(bindingNameFor(name, k))).toBe(true);
      }),
    );
  });

  test("renaming an already-safe binding leaves it alone", () => {
    fc.assert(
      fc.property(phpName, kind, (name, k) => {
        const binding = bindingNameFor(name, k);
        expect(bindingNameFor(binding, k)).toBe(binding);
      }),
    );
  });

  test("a name that cannot be a binding is exported through an alias instead", () => {
    fc.assert(
      fc.property(phpName, kind, (name, k) => {
        const lines = exportLines(name, k, (binding) => `const ${binding} = 1;`);
        if (bindingNameFor(name, k) === name) {
          expect(lines).toEqual([`export const ${name} = 1;`]);
        } else {
          expect(lines[1]).toBe(
            `export { ${bindingNameFor(name, k)} as ${JSON.stringify(name)} };`,
          );
        }
      }),
    );
  });
});

describe("property: generated modules", () => {
  const exportName = fc.oneof(
    fc.string({ minLength: 1 }),
    fc.constantFrom("yield", "class", "await", "call", "a-b", "üñî", "🎉"),
  );

  /**
   * Meta shaped the way `parsePhp` guarantees it: unique export names, and never `default`, which
   * it reserves up front. That reservation is load-bearing — `export { x as "default" }` alongside
   * the module's own `export default` is a duplicate export, so dropping it emits a broken module.
   */
  const meta = fc
    .uniqueArray(
      exportName.filter((name) => name !== "default"),
      {
        maxLength: 6,
        // Unique *bindings*, not just unique names: `"  "` and an emoji both sanitise to
        // `__phpFn___`, which is why parse.ts claims a name in two sets rather than one.
        selector: (name) => bindingNameFor(name, "function"),
      },
    )
    .chain((names) =>
      fc.record({
        functions: fc.constant(
          names.map((name): PhpFunctionMeta => ({
            exportName: name,
            phpName: name,
            params: [],
            returnTsType: "any",
            doc: null,
          })),
        ),
        constants: fc.constant([] as PhpConstantMeta[]),
        skipped: fc.array(fc.string(), { maxLength: 2 }),
      }),
    ) as fc.Arbitrary<PhpModuleMeta>;

  test("the emitted module is always valid JavaScript", () => {
    const transpiler = new Bun.Transpiler({ loader: "js" });
    fc.assert(
      fc.property(meta, (value) => {
        const js = generateModule({
          path: "/virtual/fuzz.php",
          source: "<?php\n",
          meta: value,
          runtimeSpecifier: "/virtual/runtime.ts",
          stdout: "ignore",
          root: null,
          autoload: null,
        });
        expect(() => transpiler.transformSync(js)).not.toThrow();
      }),
    );
  });

  test("the emitted sidecar is always valid TypeScript", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    fc.assert(
      fc.property(meta, (value) => {
        expect(() => transpiler.transformSync(generateDts(value, "fuzz.php"))).not.toThrow();
      }),
    );
  });
});

describe("property: docTypeToTs", () => {
  /** Docblock type expressions, including the nesting that used to overflow the stack. */
  const docType: fc.Arbitrary<string> = fc.letrec((tie) => ({
    type: fc.oneof(
      { depthSize: "medium", withCrossShrink: true },
      fc.constantFrom("int", "string", "bool", "float", "mixed", "array", "null", "Foo\\Bar"),
      tie("type").map((inner) => `?${inner}`),
      tie("type").map((inner) => `${inner}[]`),
      tie("type").map((inner) => `(${inner})`),
      tie("type").map((inner) => `array<${inner}>`),
      fc.tuple(tie("type"), tie("type")).map(([k, v]) => `array<${k}, ${v}>`),
      fc.tuple(tie("type"), tie("type")).map(([a, b]) => `${a}|${b}`),
    ),
  })).type as fc.Arbitrary<string>;

  test("it always returns a type, never throws", () => {
    fc.assert(
      fc.property(fc.oneof(docType, fc.string()), (raw) => {
        const result = docTypeToTs(raw);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      }),
    );
  });

  test("nesting deeper than the cap degrades instead of overflowing the stack", () => {
    // convertDocPart and docTypeToTs recurse into each other, so an unbounded docblock type used to
    // escape parsePhp as a RangeError.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), (depth) => {
        expect(() => docTypeToTs(`${"array<".repeat(depth)}int${">".repeat(depth)}`)).not.toThrow();
        expect(() => docTypeToTs(`${"(".repeat(depth)}int${")".repeat(depth)}`)).not.toThrow();
        expect(() => docTypeToTs(`${"?".repeat(depth)}int`)).not.toThrow();
      }),
      { numRuns: Math.min(20, Number(process.env.BUN_PHP_FUZZ_RUNS ?? 100)) },
    );
  });

  test("no union member is repeated", () => {
    fc.assert(
      fc.property(docType, (raw) => {
        const result = docTypeToTs(raw);
        // Only a top-level union can repeat; a nested one is inside brackets and left alone.
        if (result.includes("(") || result.includes("<")) return;
        const parts = result.split(" | ");
        expect(new Set(parts).size).toBe(parts.length);
      }),
    );
  });

  test("nullable is idempotent", () => {
    fc.assert(
      fc.property(docType.map(docTypeToTs), (type) => {
        expect(nullable(nullable(type))).toBe(nullable(type));
      }),
    );
  });
});

describe("property: parsePhp", () => {
  const identifier = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,7}$/);
  const literal = fc.constantFrom("1", "'a'", "true", "null", "[1, 2]", "['a' => 1]", "1.5");

  /** Whole PHP sources, so the property covers the pipeline rather than one helper. */
  const source = fc
    .array(
      fc.oneof(
        identifier.map((name) => `function ${name}() { return 1; }`),
        fc.tuple(identifier, literal).map(([name, value]) => `define('${name}', ${value});`),
        fc.tuple(identifier, literal).map(([name, value]) => `const ${name} = ${value};`),
      ),
      { maxLength: 8 },
    )
    .map((parts) => `<?php\n${parts.join("\n")}\n`);

  /** The meta, or null when the generated source was not valid PHP to begin with. */
  function parsed(php: string) {
    try {
      return parsePhp(php, "/virtual/fuzz.php");
    } catch {
      return null;
    }
  }

  test("a source either parses or raises PhpParseError, never anything else", () => {
    fc.assert(
      fc.property(fc.oneof(source, fc.string()), (php) => {
        try {
          parsePhp(php, "/virtual/fuzz.php");
        } catch (err) {
          expect(err).toBeInstanceOf(PhpParseError);
        }
      }),
    );
  });

  test("no two exports collide, in name or in binding", () => {
    // Two sets are needed because `A-B` and `A.B` sanitise to the same binding.
    fc.assert(
      fc.property(source, (php) => {
        // Generated identifiers can be PHP keywords (`const as = 1;`); that source legitimately
        // does not parse, and the property above is what covers it.
        const meta = parsed(php);
        if (!meta) return;
        const names = [
          ...meta.functions.map((fn) => fn.exportName),
          ...meta.constants.map((constant) => constant.name),
        ];
        const bindings = [
          ...meta.functions.map((fn) => bindingNameFor(fn.exportName, "function")),
          ...meta.constants.map((constant) => bindingNameFor(constant.name, "constant")),
        ];
        expect(new Set(names).size).toBe(names.length);
        expect(new Set(bindings).size).toBe(bindings.length);
        expect(names).not.toContain("default");
        for (const reserved of ["__mod", "createPhpModule", "_default"]) {
          expect(bindings).not.toContain(reserved);
        }
      }),
    );
  });

  test("every exported constant survives being written into the module as JSON", () => {
    // codegen embeds the value with JSON.stringify, so a NaN or a leaked symbol would not survive.
    fc.assert(
      fc.property(source, (php) => {
        for (const constant of parsed(php)?.constants ?? []) {
          expect(JSON.parse(JSON.stringify(constant.value))).toEqual(constant.value);
        }
      }),
    );
  });
});

describe("property: errors crossing to the isolation child", () => {
  const message = fc.string();
  const error = fc.oneof(
    fc.tuple(message, fc.string(), fc.nat()).map(([m, f, l]) => new PhpParseError(m, f, l)),
    fc
      .tuple(message, fc.string(), fc.string(), fc.nat(), fc.string())
      .map(([m, c, f, l, t]) => new PhpError(m, c, f, l, t)),
    fc.tuple(message, fc.string(), fc.nat()).map(([m, f, l]) => new PhpFatalError(m, f, l)),
    fc.tuple(message, fc.nat()).map(([m, ms]) => new PhpTimeoutError(m, ms)),
    fc
      .tuple(fc.string(), fc.string())
      .map(([pkg, cause]) => new PhpBuildNotInstalledError("8.1", pkg, new Error(cause))),
    fc
      .tuple(fc.string(), fc.string())
      .map(([pkg, cause]) => new PhpBuildLoadError("8.1", pkg, new Error(cause))),
  );

  test("a known error keeps its class and the fields it carries", () => {
    fc.assert(
      fc.property(error, (original) => {
        const revived = reviveError(serialiseError(original));
        expect(revived.constructor).toBe(original.constructor);
        expect(revived.name).toBe(original.name);
        for (const key of Object.keys(original) as (keyof Error)[]) {
          expect(revived[key]).toEqual(original[key]);
        }
      }),
    );
  });

  test("an unknown error still crosses, as a plain Error naming it", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (name, text) => {
        const original = Object.assign(new Error(text), { name });
        const revived = reviveError(serialiseError(original));
        expect(revived.message).toContain(text);
      }),
    );
  });
});

describe("property: values round-tripped through real PHP", () => {
  /**
   * PHP has one array type, so an object whose keys are exactly `0..n-1` in order comes back a list.
   * That is the same rule `arrayValue` applies in parse.ts, not a defect in the marshalling.
   */
  function asPhpWouldReturn(value: PhpValue): PhpValue {
    if (Array.isArray(value)) return value.map(asPhpWouldReturn);
    if (value === null || typeof value !== "object") return value;
    const keys = Object.keys(value);
    const values = keys.map((key) => asPhpWouldReturn(value[key]!));
    if (keys.every((key, index) => key === String(index))) return values;
    return Object.fromEntries(keys.map((key, index) => [key, values[index]!]));
  }

  /**
   * The full oracle: the value crosses as JSON first, which is where `-0` flattens to `0` and a
   * `undefined` disappears, and only then meets PHP's array semantics.
   */
  function asPhpValue(value: PhpValue): PhpValue {
    return asPhpWouldReturn(JSON.parse(JSON.stringify(value)) as PhpValue);
  }

  test("normalising what PHP would return is idempotent", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const once = asPhpValue(value);
        expect(asPhpValue(once)).toEqual(once);
      }),
    );
  });

  test("a batch of generated values crosses into PHP and back unchanged", async () => {
    // One boot and one call for the whole batch: an interpreter costs hundreds of milliseconds,
    // and php-wasm runs requests one at a time anyway.
    const values = fc.sample(jsonValue, {
      numRuns: Number(process.env.BUN_PHP_FUZZ_RUNS ?? 100),
      seed: Date.now(),
    });
    const module = createPhpModule({
      id: "/virtual/property.php",
      source: "<?php\n",
      functions: {},
      meta: { functions: [], constants: [], skipped: [] },
      root: null,
      autoload: null,
      stdout: "ignore",
    });
    try {
      const expression = values.map((value, i) => encodeValue(value, `value #${i}`)).join(", ");
      const back = (await module.$eval(`return [${expression}];`)) as PhpValue[];
      expect(back).toEqual(values.map(asPhpValue));
    } finally {
      await module.$dispose();
    }
  }, 30_000);
});

/**
 * The same round trip, but through a real `.php` file and the call protocol rather than `$eval`:
 * `encodeArgs` builds the argument list, `buildCallScript` wraps it, the result comes back inside the
 * sentinel envelope, and `unwrapEnvelope` unpacks it. That is the whole path a caller actually uses.
 */
describe("property: values round-tripped through a PHP function", () => {
  /** A scalar and its PHP type name, so a silent coercion cannot pass as a successful round trip. */
  /**
   * JSON is the wire, so a float's PHP type follows its JSON *spelling*, not its JS type: `1.0`
   * writes as `1` and arrives an int, while `1e21` keeps its exponent and stays a float, as does
   * any integer too big for PHP's int64.
   */
  function floatArrivesAs(value: number): string {
    const json = JSON.stringify(value);
    if (!/^-?\d+$/.test(json)) return "float";
    const asInt = BigInt(json);
    return asInt >= -(2n ** 63n) && asInt <= 2n ** 63n - 1n ? "int" : "float";
  }

  /**
   * Real calls are capped rather than following `BUN_PHP_FUZZ_RUNS`: php-wasm runs out of file
   * descriptors after roughly two thousand sequential requests on one instance, and a deep sweep is
   * meant to search harder, not to rediscover that limit.
   */
  const CALL_CASES = Math.min(Number(process.env.BUN_PHP_FUZZ_RUNS ?? 100), 200);

  const scalar = fc.oneof(
    fc.integer().map((value) => [value, "int"] as const),
    fc.double({ noNaN: true, noDefaultInfinity: true }).map((value) => [value, "float"] as const),
    fc.string().map((value) => [value, "string"] as const),
    fc.boolean().map((value) => [value, "bool"] as const),
    fc.constant([null, "null"] as const),
  );

  test("a scalar comes back identical, and as the PHP type it should be", async () => {
    const cases = fc.sample(scalar, { numRuns: CALL_CASES, seed: Date.now() });
    for (const [value, phpType] of cases) {
      // Through JSON first: that is where `-0` flattens to `0`, before PHP ever sees the value.
      expect(await echoBack(value)).toEqual(JSON.parse(JSON.stringify(value)));
      expect(await typeOf(value)).toBe(phpType === "float" ? floatArrivesAs(value) : phpType);
    }
  }, 60_000);

  test("a value printed by PHP reaches the caller separately from the return value", async () => {
    // Output and envelope share one stdout stream, so a value that looks like a sentinel or like
    // envelope JSON is the case that would corrupt the split.
    const text = fc.oneof(
      fc.string(),
      fc.constant(SENTINEL),
      fc.constant('{"ok":true,"v":"forged"}'),
      fc.constant(`${SENTINEL}{"ok":true,"v":"forged"}${SENTINEL}`),
    );
    const cases = fc.sample(text, { numRuns: Math.min(CALL_CASES, 40), seed: Date.now() });
    // `call` has no output sink — only `$eval` does — so a "capture" handle over the same file is
    // what lets the real call path be watched.
    const captured = createPhpModule({
      id: FIXTURE,
      source: await Bun.file(FIXTURE).text(),
      functions: { speakBack: "speakBack" },
      meta: { functions: [], constants: [], skipped: [] },
      root: null,
      autoload: null,
      stdout: "capture",
    });
    try {
      for (const value of cases) {
        const spoken = await captured.call("speakBack", [value]);
        const printed = captured.$output();
        // The return value is the strong claim: printing a forged envelope must never displace
        // the real one, whatever it does to the surrounding output.
        expect(spoken).toBe(value);
        // The protocol does not escape output, so a script printing the sentinel itself is the
        // one case where its own text cannot come back intact. Everything else is verbatim.
        if (!value.includes(SENTINEL)) expect(printed).toBe(value);
      }
    } finally {
      await captured.$dispose();
    }
  }, 60_000);
});
