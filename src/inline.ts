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

// Values become PHP expressions, never text, so a value can never run as code.
function fillTemplate(strings: TemplateStringsArray, values: unknown[]): string {
  let code = strings[0] ?? "";
  values.forEach((value, i) => {
    code += encodeValue(value, `BunPHP: interpolation #${i + 1}`) + (strings[i + 1] ?? "");
  });
  return code;
}

const HEREDOC =
  /^<<<[ \t]*(?:"([A-Za-z_\x80-\uffff]\w*)"|'([A-Za-z_\x80-\uffff]\w*)'|([A-Za-z_\x80-\uffff]\w*))\r?\n/;

/** Past the string literal opening at `i`; a backslash escapes the next character in every flavour. */
function skipString(code: string, i: number): number {
  const quote = code[i];
  for (let j = i + 1; j < code.length; j++) {
    if (code[j] === "\\") j++;
    else if (code[j] === quote) return j + 1;
  }
  return code.length;
}

/** Past the heredoc/nowdoc opening at `i`, or `i` itself when `<<<` starts something else. */
function skipHeredoc(code: string, i: number): number {
  const open = HEREDOC.exec(code.slice(i));
  if (!open) return i;
  const label = open[1] ?? open[2] ?? open[3];
  const start = i + open[0].length;
  // PHP 7.3 lets the terminator be indented, and it ends the body wherever it appears.
  const end = new RegExp(`^[ \t]*${label}(?!\\w)`, "m").exec(code.slice(start));
  return end ? start + end.index + end[0].length : code.length;
}

/**
 * Where `code` leaves the parser, read from `inCode`, and whether an open tag turns up while still in
 * code mode — a snippet that meant to start in markup. Tags inside string literals, comments and
 * heredocs are not tags, which `includes`/`lastIndexOf` cannot tell apart.
 */
function scanMode(code: string, inCode: boolean): { markupFirst: boolean; endsInCode: boolean } {
  let markupFirst = false;
  let i = 0;

  while (i < code.length) {
    if (!inCode) {
      const open = code.indexOf("<?", i);
      if (open < 0) break;
      inCode = true;
      i = open + (code.startsWith("<?php", open) ? 5 : code.startsWith("<?=", open) ? 3 : 2);
    } else if (code.startsWith("?>", i)) {
      // Code ran before this tag, so whatever opens later cannot make the snippet markup-first.
      inCode = false;
      i += 2;
    } else if (code.startsWith("<?", i)) {
      // Never a tag in code mode, but nothing else puts `<?` there: the snippet opened with markup.
      markupFirst = true;
      i += 2;
    } else if (code[i] === "'" || code[i] === '"' || code[i] === "`") {
      i = skipString(code, i);
    } else if (code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
    } else if (code.startsWith("//", i) || (code[i] === "#" && code[i + 1] !== "[")) {
      // A `?>` closes PHP mode from inside a line comment, unlike one inside a block comment.
      const newline = code.indexOf("\n", i);
      const close = code.indexOf("?>", i);
      if (close >= 0 && (newline < 0 || close < newline)) {
        inCode = false;
        i = close + 2;
      } else i = newline < 0 ? code.length : newline + 1;
    } else if (code.startsWith("<<<", i)) {
      const past = skipHeredoc(code, i);
      i = past > i ? past : i + 1;
    } else i++;
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
  let body = code;
  if (/^\s*<\?/.test(code)) {
    body = code.replace(/^\s*<\?(php\b|=)?/, (tag) => (tag.endsWith("=") ? "echo " : ""));
  } else if (scanMode(code, true).markupFirst) {
    body = `?>${code}`;
  }
  // A leading `?>` flips the scan to markup at index 0, so every branch can be read from code mode.
  if (!scanMode(body, true).endsInCode) body += "\n<?php ";
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
  /** Resolve to the output instead of printing it; a top-level `return` still wins. */
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
