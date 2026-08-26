import { encodeValue } from "./marshal";
import { createPhpModule } from "./runtime";
import type { PhpModuleApi } from "./types";

/**
 * Run PHP written inline, without a `.php` file:
 *
 *     await BunPHP`<?php echo "Hello world";`;          // prints "Hello world"
 *     await BunPHP.capture`<?php echo "Hello world";`;  // "Hello world"
 *
 * Unlike importing a `.php` file, this needs no plugin registration — it is a
 * plain runtime API, so it works without the `preload` entry in bunfig.toml.
 */

/** Where the (empty) inline module lives inside the virtual filesystem. */
const INLINE_ID = "/bun-php/inline.php";

let inlineModule: PhpModuleApi | null = null;

function instance(): PhpModuleApi {
  if (inlineModule) return inlineModule;

  inlineModule = createPhpModule({
    id: INLINE_ID,
    source: "<?php\n",
    functions: {},
    meta: { functions: [], constants: [], skipped: [] },
    root: null,
    autoload: null,
    // "inherit" so a snippet's output reaches the terminal as PHP writes it,
    // rather than in one piece once the request is over. `BunPHP.capture`
    // passes `$eval` a sink instead, which overrides this per call, so both
    // tags share the one interpreter.
    stdout: "inherit",
  });

  return inlineModule;
}

/**
 * Serialise snippets so one call's output can never be drained by another.
 *
 * The interpreter already runs one request at a time, but the captured output
 * is read in a second step, so overlapping callers could otherwise interleave.
 */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Build PHP source from the template.
 *
 * Interpolated values are converted to PHP *expressions* rather than pasted in
 * as text, so a value can never be read as code. They therefore belong where an
 * expression is valid, not inside a PHP string literal:
 *
 *     await BunPHP`<?php return "Hello " . ${name};`;   // correct
 *     await BunPHP`<?php return "Hello ${name}";`;      // literal, not the value
 */
function compose(strings: TemplateStringsArray, values: unknown[]): string {
  let code = strings[0] ?? "";

  for (let index = 0; index < values.length; index++) {
    code += encodeValue(values[index], `BunPHP: interpolation #${index + 1}`);
    code += strings[index + 1] ?? "";
  }

  return code;
}

/**
 * Whether the snippet finishes in markup mode, having used `?>`.
 *
 * Open tags inside string literals would fool this, which is not a shape short
 * inline snippets take.
 */
function endsInHtmlMode(code: string): boolean {
  return code.lastIndexOf("?>") > code.lastIndexOf("<?");
}

/**
 * Turn a snippet into a closure body, preserving PHP's own file semantics.
 *
 * A PHP file starts in markup mode, switches to code at `<?php`, and may leave
 * it again at the (optional) `?>`. The snippet runs inside a closure, which
 * starts in *code* mode instead, so the two ends are reconciled here — which is
 * also why a tag-less snippet is code, not the markup a tag-less file would be:
 *
 *   - a snippet that opens with a tag has it stripped, since the closure is
 *     already in code mode;
 *   - one that starts with markup but uses tags later is prefixed with `?>`, so
 *     the leading markup is emitted the way a PHP file would emit it;
 *   - one with no tags at all is taken as PHP code, which is what an inline
 *     snippet is for;
 *   - one that ends in markup re-enters code mode, or the wrapper's closing
 *     brace would be swallowed as literal text.
 *
 * PHP discards a single newline directly after `?>`, so the re-entry adds no
 * output of its own.
 */
function toClosureBody(code: string): string {
  let body: string;

  if (/^\s*<\?/.test(code)) {
    // Opens with a tag: the closure is already in code mode, so drop it.
    body = code.replace(/^\s*<\?(php\b|=)?/, (match) =>
      match.trimEnd().endsWith("=") ? "echo " : "",
    );
  } else if (/<\?/.test(code)) {
    // Uses tags, but starts with markup: emit that markup first, as a PHP file
    // would.
    body = `?>${code}`;
  } else {
    // No tags at all. Treated as PHP code rather than markup, since that is
    // what an inline snippet is for; markup-only text has no reason to go
    // through PHP.
    body = code;
  }

  if (endsInHtmlMode(body)) body += "\n<?php ";

  return body;
}

/**
 * Evaluate a snippet, either printing what it prints or handing it back.
 *
 * `capture: false` matches how an imported `.php` file behaves — PHP's `echo`
 * reaches the terminal as it is written, and the snippet's value is its
 * top-level `return`.
 */
function evaluate(
  strings: TemplateStringsArray,
  values: unknown[],
  capture: boolean,
  name: string,
): Promise<any> {
  if (!Array.isArray(strings) || !("raw" in Object(strings))) {
    return Promise.reject(
      new TypeError(
        `${name} is a tagged template: write ${name}\`<?php ... \` rather than ${name}(...)`,
      ),
    );
  }

  return enqueue(async () => {
    // Composed inside the task so an interpolation that cannot be encoded
    // rejects the returned promise instead of throwing synchronously.
    const code = toClosureBody(compose(strings, values));
    const module = instance();

    if (!capture) return module.$eval(code);

    // The sink belongs to this call alone, so a snippet that throws part-way
    // through printing cannot leave its output behind for the next one.
    let output = "";
    const value = await module.$eval(code, (text) => {
      output += text;
    });
    return value ?? output;
  });
}

export interface BunPHPTag {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any>;
  /** Evaluate a snippet, returning its output instead of printing it. */
  capture(strings: TemplateStringsArray, ...values: unknown[]): Promise<any>;
  /** Shut the inline interpreter down and release it. */
  dispose(): Promise<void>;
  /** The underlying module, for `$php()` and friends. */
  module(): PhpModuleApi;
}

/**
 * Evaluate a PHP snippet, printing whatever it prints.
 *
 * Output goes to the terminal, as it does for an imported `.php` file and for
 * PHP itself; the promise resolves to the value of a top-level `return`, or to
 * `null` — PHP's own answer for a closure that returns nothing — when there is
 * no `return`:
 *
 *     await BunPHP`<?php echo "Hello world";`;   // prints; resolves to null
 *     await BunPHP`<?php return 40 + 2;`;        // 42
 *
 * Use `BunPHP.capture` to take the output as a value instead.
 */
export const BunPHP: BunPHPTag = Object.assign(
  function BunPHP(strings: TemplateStringsArray, ...values: unknown[]): Promise<any> {
    return evaluate(strings, values, false, "BunPHP");
  },
  {
    /**
     * Evaluate a PHP snippet and resolve to what it printed.
     *
     * Nothing reaches the terminal. A top-level `return` still wins over the
     * output, so a snippet that returns nothing resolves to its output, and one
     * that prints nothing resolves to an empty string:
     *
     *     await BunPHP.capture`<?php echo "Hello world";`;   // "Hello world"
     *     await BunPHP.capture`<?php return 40 + 2;`;        // 42
     */
    capture(strings: TemplateStringsArray, ...values: unknown[]): Promise<any> {
      return evaluate(strings, values, true, "BunPHP.capture");
    },
    async dispose(): Promise<void> {
      const module = inlineModule;
      inlineModule = null;
      await module?.$dispose();
    },
    module(): PhpModuleApi {
      return instance();
    },
  },
);
