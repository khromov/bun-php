import { Engine } from "php-parser";
import { encodeValue } from "./marshal";
import { createPhpModule } from "./runtime";
import type { PhpModuleApi } from "./types";

const INLINE_ID = "/bun-php/inline.php";

let shared: PhpModuleApi | null = null;

// One interpreter serves both tags: `capture` hands `$eval` a sink, which overrides "inherit" for
// that call alone.
function sharedModule(): PhpModuleApi {
  return (shared ??= createPhpModule({
    id: INLINE_ID,
    source: "<?php\n",
    functions: {},
    meta: { functions: [], constants: [], skipped: [] },
    root: null,
    autoload: null,
    stdout: "inherit",
  }));
}

/**
 * Values become PHP expressions, never text, so a value can never run as code. The segments come
 * from `raw`: the snippet is PHP source, and cooked strings let JavaScript eat its escapes first,
 * which silently turns `preg_match('/\d+/')` into `/d+/` and `\DateTime` into `DateTime`. A raw
 * segment is also never `undefined`, so an invalid escape can no longer erase the whole snippet.
 */
function fillTemplate(strings: TemplateStringsArray, values: unknown[]): string {
  const segments = strings.raw;
  let code = segments[0] ?? "";
  values.forEach((value, i) => {
    code += encodeValue(value, `BunPHP: interpolation #${i + 1}`) + (segments[i + 1] ?? "");
  });
  return code;
}

/** php-parser names multi-character tokens; a single-character token is just that character. */
function tokenName(token: string | string[]): string {
  return typeof token === "string" ? token : (token[0] as string);
}

/**
 * The snippet with enough `]` appended to close every unmatched `[`. An unterminated `#[` attribute
 * sends php-parser's attribute lexer into an infinite loop no `try` can catch, and a closing bracket
 * is all it needs to terminate; the padding lands past the last token, where it can change neither
 * `markupFirst` nor `endsInCode`.
 */
function bracketBalanced(code: string): string {
  let open = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "[") open++;
    else if (code[i] === "]" && open > 0) open--;
  }
  return open > 0 ? code + "]".repeat(open) : code;
}

/**
 * Where the snippet leaves the parser when read as code, and whether an open tag turns up before any
 * code ran — a snippet that meant to start in markup. PHP's own lexer decides which `<?` and `?>` are
 * tags, so ones inside string literals, heredocs and comments cannot fool it. `tokenGetAll` has no
 * eval mode, so the `<?php ` prefix is what starts it in code mode. Exported so the property tests
 * can state `asClosureBody`'s postcondition without booting wasm.
 */
export function scanMode(code: string): { markupFirst: boolean; endsInCode: boolean } {
  // The Engine constructor mutates its options object, so build a fresh one each time.
  const engine = new Engine({ parser: { suppressErrors: true, version: 805 } });
  let tokens: (string | string[])[];
  try {
    // Balanced first: an unterminated `#[` hangs the lexer, which no `try` below could catch.
    tokens = engine.tokenGetAll(`<?php ${bracketBalanced(code)}`) as (string | string[])[];
  } catch {
    // `suppressErrors` covers the parser, not the lexer, which throws outright on a malformed
    // attribute (`#[?`). Leaving the snippet alone is right for both: PHP's own error names the
    // real problem, where a php-parser internal would not.
    return { markupFirst: false, endsInCode: true };
  }

  let inCode = true;
  let markupFirst = false;
  for (let i = 0; i < tokens.length; i++) {
    const name = tokenName(tokens[i]!);
    if (name === "T_OPEN_TAG" || name === "T_OPEN_TAG_WITH_ECHO") inCode = true;
    else if (name === "T_CLOSE_TAG" || name === "T_INLINE_HTML") inCode = false;
    // Never a tag in code mode, but nothing else puts `<?` there: the snippet opened with markup.
    else if (inCode && name === "<" && tokenName(tokens[i + 1] ?? "") === "?") markupFirst = true;
  }

  return { markupFirst, endsInCode: inCode };
}

/**
 * A snippet runs inside a closure, which starts in code mode, whereas a PHP file starts in markup
 * mode. So a leading open tag is dropped (`<?=` becomes `echo`), leading markup before a later tag is
 * kept by prefixing `?>`, no tags at all means code, and a snippet ending in markup re-enters code
 * mode so the wrapper's closing brace is not swallowed as text. PHP drops the one newline after `?>`,
 * so that re-entry prints nothing.
 */
export function asClosureBody(code: string): string {
  // One pattern for both the test and the strip, so they cannot disagree. `<?PHP` is as valid as
  // `<?php`; a bare `<?` is not a tag at all, because short tags are pinned off.
  const OPEN_TAG = /^\s*<\?(php\b|=)/i;

  let body = code;
  if (OPEN_TAG.test(code)) {
    body = code.replace(OPEN_TAG, (tag) => (tag.endsWith("=") ? "echo " : ""));
  } else if (scanMode(code).markupFirst) {
    body = `?>${code}`;
  }
  // A leading `?>` is the first token the lexer sees, so every branch can be read from code mode.
  if (!scanMode(body).endsInCode) body += "\n<?php ";
  return body;
}

async function evaluate(
  strings: TemplateStringsArray,
  values: unknown[],
  capture: boolean,
  name: string,
): Promise<any> {
  if (!Array.isArray(strings) || !("raw" in Object(strings))) {
    throw new TypeError(
      `${name} is a tagged template: write ${name}\`<?php ... \` rather than ${name}(...)`,
    );
  }
  const code = asClosureBody(fillTemplate(strings, values));
  if (!capture) return sharedModule().$eval(code);

  // A sink per call, so a snippet that throws part-way through printing leaves nothing behind.
  let output = "";
  const value = await sharedModule().$eval(code, (text) => {
    output += text;
  });
  return value ?? output;
}

export interface BunPHPTag {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any>;
  /** Resolve to the output instead of printing it; any non-null `return` wins, `false` and `""` too. */
  capture(strings: TemplateStringsArray, ...values: unknown[]): Promise<any>;
  /** Shut the inline interpreter down. */
  dispose(): Promise<void>;
  /** The underlying module, for `$php()` and friends. */
  module(): PhpModuleApi;
}

/** Run inline PHP, printing as it runs; resolves to the top-level `return`, or `null`. */
export const BunPHP: BunPHPTag = Object.assign(
  function BunPHP(strings: TemplateStringsArray, ...values: unknown[]): Promise<any> {
    return evaluate(strings, values, false, "BunPHP");
  },
  {
    capture(strings: TemplateStringsArray, ...values: unknown[]): Promise<any> {
      return evaluate(strings, values, true, "BunPHP.capture");
    },
    async dispose(): Promise<void> {
      const module = shared;
      shared = null;
      await module?.$dispose();
    },
    module: sharedModule,
  },
);
