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

/**
 * A snippet runs inside a closure, which starts in code mode, whereas a PHP file starts in markup
 * mode. So a leading open tag is dropped (`<?=` becomes `echo`), leading markup before a later tag is
 * kept by prefixing `?>`, no tags at all means code, and a snippet ending in markup re-enters code
 * mode so the wrapper's closing brace is not swallowed as text. PHP drops the one newline after `?>`,
 * so that re-entry prints nothing.
 */
function asClosureBody(code: string): string {
  let body = code;
  if (/^\s*<\?/.test(code)) {
    body = code.replace(/^\s*<\?(php\b|=)?/, (tag) => (tag.endsWith("=") ? "echo " : ""));
  } else if (code.includes("<?")) {
    body = `?>${code}`;
  }
  // An open tag inside a string literal would fool this; inline snippets do not take that shape.
  if (body.lastIndexOf("?>") > body.lastIndexOf("<?")) body += "\n<?php ";
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
