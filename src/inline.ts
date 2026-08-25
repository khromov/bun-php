import { encodeValue } from "./marshal";
import { createPhpModule } from "./runtime";
import type { PhpModuleApi } from "./types";

/**
 * Run PHP written inline, without a `.php` file:
 *
 *     await BunPHP`<?php echo "Hello world";`;
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
    // Output is returned to the caller rather than printed.
    stdout: "capture",
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
 * it again at `?>` — where both the opening and the closing tag are optional.
 * The snippet runs inside a closure, which starts in *code* mode, so the two
 * ends are reconciled here:
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

export interface BunPHPTag {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any>;
  /** Shut the inline interpreter down and release it. */
  dispose(): Promise<void>;
  /** The underlying module, for `$php()` and friends. */
  module(): PhpModuleApi;
}

/**
 * Evaluate a PHP snippet.
 *
 * Resolves to the value of a top-level `return`, or to whatever the snippet
 * printed when it does not return one:
 *
 *     await BunPHP`<?php echo "Hello world";`;   // "Hello world"
 *     await BunPHP`<?php return 40 + 2;`;        // 42
 */
export const BunPHP: BunPHPTag = Object.assign(
  function BunPHP(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<any> {
    if (!Array.isArray(strings) || !("raw" in Object(strings))) {
      return Promise.reject(
        new TypeError(
          "BunPHP is a tagged template: write BunPHP`<?php ... ` rather than BunPHP(...)",
        ),
      );
    }

    return enqueue(async () => {
      // Composed inside the task so an interpolation that cannot be encoded
      // rejects the returned promise instead of throwing synchronously.
      const code = toClosureBody(compose(strings, values));
      const module = instance();
      const value = await module.$eval(code);
      const output = module.$output();
      return value ?? output;
    });
  },
  {
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
