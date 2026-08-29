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

// `<?PHP` is as valid as `<?php`; a bare `<?` is not a tag, because short tags are pinned off.
const OPEN_TAG = /^\s*<\?(php\b|=)/i;
const CLOSE_TAG = /\?>\s*$/;

/**
 * A snippet runs inside a closure, which starts in code mode, so the tags a PHP file needs are
 * stripped rather than honoured: a leading `<?php` is dropped, `<?=` becomes `echo`, and a trailing
 * `?>` becomes `;` (it doubles as a statement terminator, so `<?= 6 * 7 ?>` stays valid without it).
 * Everything in between is code — inline markup is not supported, and a snippet that starts or ends
 * in markup fails with PHP's own parse error.
 */
export function asClosureBody(code: string): string {
  return code
    .replace(OPEN_TAG, (tag) => (tag.endsWith("=") ? "echo " : ""))
    .replace(CLOSE_TAG, ";");
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
