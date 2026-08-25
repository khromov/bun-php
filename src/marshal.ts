import { phpVar } from "@php-wasm/util";
import { PhpError, PhpFatalError } from "./errors";

/**
 * Marker separating the PHP script's own output from the result envelope.
 *
 * A sentinel is used rather than relying on output buffering alone because PHP
 * flushes open buffers to stdout when a fatal error occurs, so captured output
 * can still reach stdout ahead of the envelope.
 */
const SENTINEL = "\u0000BUNPHP\u0000";

/** The same marker written as a PHP double-quoted literal. */
const PHP_SENTINEL = '"\\x00BUNPHP\\x00"';

interface SuccessEnvelope {
  ok: true;
  v: unknown;
  out?: string;
}

interface ThrowableEnvelope {
  ok: false;
  e: { class: string; msg: string; file: string; line: number; trace: string };
  out?: string;
}

interface FatalEnvelope {
  ok: false;
  fatal: { msg: string; file: string; line: number };
  out?: string;
}

export type Envelope = SuccessEnvelope | ThrowableEnvelope | FatalEnvelope;

const MAX_INT64 = 2n ** 63n - 1n;
const MIN_INT64 = -(2n ** 63n);

/**
 * Encode JS arguments as a PHP argument list.
 *
 * Trailing `undefined` arguments are dropped so PHP parameter defaults apply —
 * the natural meaning of forwarding an optional value that was never set. An
 * `undefined` hole before a defined argument has no PHP spelling, so it is
 * rejected rather than silently sent as `null`.
 */
export function encodeArgs(args: readonly unknown[], label = "call"): string {
  let length = args.length;
  while (length > 0 && args[length - 1] === undefined) length--;

  const parts: string[] = [];
  for (let i = 0; i < length; i++) {
    parts.push(encodeValue(args[i], `${label}: argument #${i + 1}`));
  }
  return parts.join(", ");
}

/**
 * Encode one JS value as a PHP expression. `context` names the value in error
 * messages, e.g. `greet: argument #1` or `BunPHP: interpolation #2`.
 */
export function encodeValue(value: unknown, context: string): string {
  if (value === undefined) {
    throw new TypeError(`${context} is undefined; pass null instead`);
  }
  if (typeof value === "bigint") {
    if (value < MIN_INT64 || value > MAX_INT64) {
      throw new TypeError(`${context} (${value}n) overflows PHP's 64-bit int`);
    }
    // PHP parses `-9223372036854775808` as unary minus on an overflowing
    // int literal (yielding a float), so PHP_INT_MIN needs the classic spelling.
    return value === MIN_INT64 ? "(-9223372036854775807 - 1)" : value.toString();
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return Number.isNaN(value) ? "NAN" : value > 0 ? "INF" : "-INF";
  }
  try {
    return phpVar(value as never);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TypeError(`${context} could not be encoded: ${reason}`);
  }
}

/**
 * Build the PHP script for one call.
 *
 * Every call re-`require_once`s the module: php-wasm resets request-scoped PHP
 * state (declared functions included) between runs, so the include is both
 * necessary and safe from redeclaration errors.
 */
export function buildCallScript(
  modulePath: string,
  expression: string,
  autoloadPath?: string | null,
): string {
  // Composer's autoloader has to be registered again for every call, because
  // php-wasm resets request-scoped state (including declared functions and
  // registered autoloaders) between runs.
  const prelude = autoloadPath
    ? `    require_once ${phpVar(autoloadPath as never)};\n`
    : "";

  return `<?php
ini_set('html_errors', '0');
// Unbuffered, so \`echo\` reaches stdout while the request is still running
// rather than arriving in one piece at the end of it. The envelope is what
// separates that output from the result, which is why it can be let through.
ob_implicit_flush(true);
$__bunphp_sent = false;
$__bunphp_emit = function (array $r) use (&$__bunphp_sent) {
    if ($__bunphp_sent) { return; }
    $__bunphp_sent = true;
    $out = '';
    while (ob_get_level() > 0) { $out = ob_get_clean() . $out; }
    $r['out'] = $out;
    try {
        $json = json_encode($r, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
    } catch (\\Throwable $e) {
        $json = json_encode([
            'ok' => false,
            'out' => $out,
            'e' => [
                'class' => 'JsonException',
                'msg' => 'Return value could not be encoded: ' . $e->getMessage(),
                'file' => '',
                'line' => 0,
                'trace' => '',
            ],
        ], JSON_INVALID_UTF8_SUBSTITUTE);
        if ($json === false) {
            $json = '{"ok":false,"out":"","e":{"class":"JsonException","msg":"Return value could not be encoded","file":"","line":0,"trace":""}}';
        }
    }
    echo ${PHP_SENTINEL} . $json . ${PHP_SENTINEL};
};
register_shutdown_function(function () use ($__bunphp_emit, &$__bunphp_sent) {
    if ($__bunphp_sent) { return; }
    $err = error_get_last();
    // Only a fatal error explains reaching shutdown without a result; a stale
    // warning or notice from earlier in the request must not be blamed.
    $fatal = $err !== null && ($err['type'] & (E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR)) !== 0;
    $__bunphp_emit([
        'ok' => false,
        'fatal' => [
            'msg' => $fatal ? $err['message'] : 'PHP exited before returning a value',
            'file' => $fatal ? $err['file'] : '',
            'line' => $fatal ? $err['line'] : 0,
        ],
    ]);
});
try {
${prelude}    require_once ${phpVar(modulePath as never)};
    $__bunphp_v = ${expression};
    $__bunphp_emit(['ok' => true, 'v' => $__bunphp_v]);
} catch (\\Throwable $e) {
    $__bunphp_emit([
        'ok' => false,
        'e' => [
            'class' => get_class($e),
            'msg' => $e->getMessage(),
            'file' => $e->getFile(),
            'line' => $e->getLine(),
            'trace' => $e->getTraceAsString(),
        ],
    ]);
}
`;
}

/** How much trailing output to keep for a fatal error's detail message. */
const TAIL_LIMIT = 8192;

/**
 * Split stdout into the script's own output and the result envelope, as the
 * bytes arrive.
 *
 * The envelope sits between a sentinel pair, because output can surround it on
 * both sides: PHP flushes open buffers to stdout ahead of the envelope on a
 * fatal error, and user shutdown functions or destructors can still print
 * after the envelope has been emitted.
 *
 * Feeding it a chunk at a time is what lets `echo` reach the terminal while the
 * request is still running, and costs three pieces of bookkeeping:
 *
 *   - a sentinel can straddle a chunk boundary, so a tail that could still grow
 *     into one is held back rather than emitted;
 *   - text between sentinels that turns out not to be JSON was never an
 *     envelope, so it is put back on the wire verbatim;
 *   - the last valid envelope wins, as it does over a complete string, so once
 *     one has been seen the output after it is held until the stream ends —
 *     that way a later envelope can supersede it without the two arriving out
 *     of order.
 */
export class EnvelopeSplitter {
  /** Unclassified text, or the envelope JSON so far once `#open` is set. */
  #buffer = "";
  #open = false;
  #envelope: Envelope | null = null;
  /** The winning envelope's raw text, re-emitted if a later one supersedes it. */
  #raw = "";
  /** Output seen after the winning envelope, released when the stream ends. */
  #held = "";
  #tail = "";

  constructor(private readonly write: (text: string) => void) {}

  /** Feed the next chunk of stdout. */
  push(text: string): void {
    if (!text) return;
    this.#buffer += text;

    for (;;) {
      const index = this.#buffer.indexOf(SENTINEL);
      if (index === -1) break;
      const segment = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + SENTINEL.length);
      if (this.#open) this.#accept(segment);
      else {
        this.#out(segment);
        this.#open = true;
      }
    }

    // While open, the buffer is envelope JSON and stays put until its partner
    // sentinel shows up. Otherwise release all of it but a partial sentinel.
    if (this.#open) return;
    const keep = this.#partialSentinel();
    if (keep < this.#buffer.length) {
      this.#out(this.#buffer.slice(0, this.#buffer.length - keep));
      this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
    }
  }

  /** Close the stream and return the envelope, if one arrived. */
  end(): Envelope | null {
    if (this.#open) {
      // A lone sentinel: the process died before the closing one was written,
      // so whatever followed is the best guess at the envelope.
      const json = this.#buffer;
      this.#buffer = "";
      this.#open = false;
      if (!this.#take(json, SENTINEL + json)) this.#out(SENTINEL + json);
    } else if (this.#buffer) {
      this.#out(this.#buffer);
      this.#buffer = "";
    }

    this.#flush(this.#held);
    this.#held = "";
    return this.#envelope;
  }

  /** The last of the output, for reporting a call that produced no result. */
  get tail(): string {
    return this.#tail;
  }

  /** Handle the text between a sentinel pair. */
  #accept(json: string): void {
    this.#open = false;
    if (this.#take(json, SENTINEL + json + SENTINEL)) return;
    // Not JSON, so it was never an envelope — user output that happened to
    // contain the marker. Put it back exactly as it came.
    this.#out(SENTINEL + json + SENTINEL);
  }

  /** Adopt `json` as the envelope, superseding any earlier one. */
  #take(json: string, raw: string): boolean {
    let parsed: Envelope;
    try {
      parsed = JSON.parse(json) as Envelope;
    } catch {
      return false;
    }

    if (this.#envelope) {
      // The earlier envelope was output after all, and came first.
      this.#flush(this.#raw);
      this.#flush(this.#held);
      this.#held = "";
    }

    this.#envelope = parsed;
    this.#raw = raw;
    return true;
  }

  /** How many trailing characters could still grow into a sentinel. */
  #partialSentinel(): number {
    const max = Math.min(SENTINEL.length - 1, this.#buffer.length);
    for (let k = max; k > 0; k--) {
      if (this.#buffer.endsWith(SENTINEL.slice(0, k))) return k;
    }
    return 0;
  }

  #out(text: string): void {
    if (!text) return;
    // Once an envelope has been seen, hold its trailing output back so that a
    // later envelope can supersede it and still emit in order.
    if (this.#envelope) this.#held += text;
    else this.#flush(text);
  }

  #flush(text: string): void {
    if (!text) return;
    this.#tail = (this.#tail + text).slice(-TAIL_LIMIT);
    this.write(text);
  }
}

/**
 * Split a complete stdout string, the same way `EnvelopeSplitter` splits a
 * stream. Kept for callers that already have the whole thing in hand.
 */
export function decodeOutput(stdout: string): {
  out: string;
  envelope: Envelope | null;
} {
  let out = "";
  const splitter = new EnvelopeSplitter((text) => {
    out += text;
  });
  splitter.push(stdout);
  // `end()` first: it releases the output held back after the envelope.
  const envelope = splitter.end();
  return { out, envelope };
}

/** Turn an envelope into either the return value or a thrown error. */
export function unwrapEnvelope(envelope: Envelope, label: string): unknown {
  if (envelope.ok) return envelope.v;

  if ("fatal" in envelope) {
    throw new PhpFatalError(
      `${label}: ${envelope.fatal.msg}`,
      envelope.fatal.file,
      envelope.fatal.line,
    );
  }

  throw new PhpError(
    `${label}: ${envelope.e.class}: ${envelope.e.msg}`,
    envelope.e.class,
    envelope.e.file,
    envelope.e.line,
    envelope.e.trace,
  );
}

export { SENTINEL };
